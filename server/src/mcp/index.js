import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { z } from 'zod';
import { ah } from '../middleware/auth.js';
import { listTasks, createTask, updateTask, deleteTask } from '../routes/work.js';
import { listProjects } from '../routes/projects.js';
import { listDailySubmissions } from '../daily-work/routes.js';
import { dateValue } from '../daily-work/dates.js';
import { createWorkflowOAuth, READ, WRITE } from './oauth.js';

const id = z.string().regex(/^[0-9a-f]{24}$/i);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const priority = z.enum(['low', 'normal', 'high']);
const status = z.enum(['todo', 'in_progress', 'waiting', 'done']);
const ids = z.array(id).max(25);
const page = z.number().int().min(1).max(100000).optional();
const pageSize = z.number().int().min(1).max(50).optional();
const tools = [
  {
    name: 'list_projects', title: 'List projects',
    description: 'List projects visible to the connected Workflow account, with client IDs and workload counts.',
    inputSchema: {},
    run: async (user) => ({ projects: await listProjects(user) }),
  },
  {
    name: 'list_tasks', title: 'List tasks',
    description: 'Read scheduled task occurrences. Dates filter scheduled due dates in India Standard Time and include both endpoints. Use the separate Daily Work tool for submitted work.',
    inputSchema: {
      scope: z.enum(['mine', 'all']).optional(), view: z.enum(['all', 'overdue', 'today', 'completed', 'open']).optional(),
      client: id.optional(), project: id.optional(), assignee: id.optional(), q: z.string().max(100).optional(),
      from: date.optional(), to: date.optional(), page, pageSize,
    },
    run: (user, { from, to, ...query }) => listTasks(user, {
      scope: 'all', ...query,
      from: from && dateValue(from) + 'T00:00:00+05:30',
      to: to && dateValue(to) + 'T23:59:59.999+05:30',
    }),
  },
  {
    name: 'list_daily_work', title: 'Read Daily Work',
    description: 'Read Daily Work submissions and incomplete reasons for a specific work date (IST). Use the optional member filter or next page for large teams.',
    inputSchema: { date, memberId: id.optional(), status: z.enum(['complete', 'incomplete']).optional(), page, pageSize },
    run: async (user, { date, memberId, status, page = 1, pageSize = 10 }) => {
      const rows = await listDailySubmissions(user, { from: date, to: date, memberId, status });
      return { submissions: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: rows.length };
    },
  },
  {
    name: 'create_task', title: 'Create a one-time task', write: true,
    description: 'Create one scheduled Workflow task using a visible client/project ID and optional assignee IDs. Ask the user before creating work.',
    inputSchema: {
      title: z.string().trim().min(1).max(230), client: id, project: id.optional(), assignees: ids.optional(),
      dueDate: date, priority: priority.optional(), sop: z.string().max(3000).optional(),
    },
    run: async (user, body) => ({ task: await createTask(user, { ...body, dueDate: dateValue(body.dueDate) + 'T17:00:00+05:30' }) }),
  },
  {
    name: 'update_task', title: 'Update a task', write: true,
    description: 'Update one scheduled Workflow task. Omitted fields are preserved. Ask the user before changing work.',
    inputSchema: {
      taskId: id, title: z.string().trim().min(1).max(230).optional(), dueDate: date.optional(),
      status: status.optional(), priority: priority.optional(), assignees: ids.optional(), sop: z.string().max(3000).optional(),
    },
    run: async (user, { taskId, dueDate, ...body }) => {
      if (dueDate) body.dueDate = dateValue(dueDate) + 'T17:00:00+05:30';
      if (!Object.keys(body).length) throw Object.assign(new Error('Provide at least one field to update'), { status: 400 });
      return { task: await updateTask(user, taskId, body) };
    },
  },
  {
    name: 'delete_task', title: 'Remove one task occurrence', write: true, destructive: true,
    description: 'Super Admin only. Remove one scheduled task occurrence by exact ID using Workflow soft deletion. Ask the user to confirm the individual task before calling. Recurring schedules and Daily Work submissions are separate.',
    inputSchema: { taskId: id },
    run: (user, { taskId }) => deleteTask(user, taskId),
  },
];

function mcpServer(auth, resourceMetadataUrl) {
  const server = new McpServer({ name: 'gatp-workflow', version: '1.0.0' });
  for (const tool of tools) {
    const scope = tool.write ? WRITE : READ;
    const securitySchemes = [{ type: 'oauth2', scopes: [scope] }];
    server.registerTool(tool.name, {
      title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: !tool.write, destructiveHint: !!tool.destructive, openWorldHint: false },
      _meta: { securitySchemes },
    }, async (args) => {
      if (!auth?.scopes.includes(scope)) {
        return {
          isError: true,
          content: [{ type: 'text', text: tool.write ? 'Connect with read and write access to perform this action.' : 'Connect your Workflow account.' }],
          _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${resourceMetadataUrl}", scope="${scope}", error="${auth ? 'insufficient_scope' : 'invalid_token'}"`] },
        };
      }
      try {
        const result = await tool.run(auth.extra.user, args);
        const payload = JSON.parse(JSON.stringify(result));
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      } catch (error) {
        const message = error.status && error.status < 500 ? error.message :
          error.name === 'VersionError' ? 'Task changed. Read it again before retrying.' : 'Workflow could not complete this operation.';
        if (!error.status && error.name !== 'VersionError') console.error('Workflow MCP tool failed', tool.name, error.name);
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });
  }
  return server;
}

export function workflowMcpRouter() {
  const router = Router();
  const deploymentOrigin = process.env.WORKFLOW_MCP_ORIGIN ||
    (process.env.VERCEL_ENV === 'production' ? 'https://workflow.gatpsolutions.com' :
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!deploymentOrigin) return router;
  const origin = new URL(deploymentOrigin).origin;
  const { router: oauth, provider, resource, resourceMetadataUrl } = createWorkflowOAuth(origin);
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: [READ], expectedResource: resource, resourceMetadataUrl });

  router.use(oauth);
  router.use('/api/mcp', (req, res, next) => {
    if (req.headers.origin && ![origin, 'https://chatgpt.com'].includes(req.headers.origin)) {
      return res.status(403).json({ error: 'MCP origin denied' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.post('/api/mcp', (req, res, next) => {
    if (req.headers.authorization) return bearer(req, res, next);
    next();
  }, ah(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcpServer(req.auth, resourceMetadataUrl);
    res.on('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));
  router.all('/api/mcp', (_req, res) => res.set('Allow', 'POST').sendStatus(405));
  return router;
}

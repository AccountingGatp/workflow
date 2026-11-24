import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { z } from 'zod';
import { ah, HttpError } from '../middleware/auth.js';
import { listTasks, createTask, updateTask, deleteTask, listRecurringTasks, updateRecurringAssignments, createRecurringTask } from '../routes/work.js';
import { listProjects, createProject } from '../routes/projects.js';
import { createMasterTask } from '../routes/project-work.js';
import { listDailySubmissions } from '../daily-work/routes.js';
import { dateValue } from '../daily-work/dates.js';
import { createWorkflowOAuth, READ, WRITE, DELETE } from './oauth.js';

import { previewDailyWorkCleanup, deleteDailyWorkActivity } from '../daily-work/cleanup.js';

const id = z.string().regex(/^[0-9a-f]{24}$/i);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const priority = z.enum(['low', 'normal', 'high']);
const status = z.enum(['todo', 'in_progress', 'waiting', 'done']);
const ids = z.array(id).max(25);
const page = z.number().int().min(1).max(100000).optional();
const pageSize = z.number().int().min(1).max(50).optional();
const cleanupSelection = { memberIds: z.array(id).min(1).max(20), from: date, to: date };
const tools = [
  {
    name: 'list_recurring_tasks', title: 'List recurring tasks',
    description: 'List recurring templates within your Workflow portfolio. Filter by client, project or assignee. Includes exact template IDs and current assignments.',
    inputSchema: { client: id.optional(), project: id.optional(), assignee: id.optional(), page, pageSize },
    run: listRecurringTasks,
  },
  ...['replace', 'add', 'remove'].map((mode) => ({
    name: mode === 'replace' ? 'update_recurring_task' : mode + '_recurring_assignee',
    title: mode + ' recurring task assignments', write: true,
    description: 'Change assignments on one recurring template by exact ID. Ask the user before changing assignments. Preserves master tasks, schedule and existing occurrences; future generated occurrences use the new assignments. Replace accepts an empty array to unassign everyone.',
    inputSchema: { templateId: id, assignees: mode === 'replace' ? ids : z.array(id).min(1).max(25) },
    run: (user, { templateId, assignees }) => updateRecurringAssignments(user, templateId, assignees, mode),
  })),
  {
    name: 'list_projects', title: 'List projects',
    description: 'List projects visible to the connected Workflow account, with client IDs and workload counts.',
    inputSchema: {},
    run: async (user) => ({ projects: await listProjects(user) }),
  },
  {
    name: 'create_project', title: 'Create a Workflow project', write: true,
    description: 'Create a standalone project or add a project under an existing client you manage. First check list_projects for an existing project with the same name.',
    inputSchema: { name: z.string().trim().min(1).max(120), description: z.string().max(3000).optional(), client: id.optional() },
    run: async (user, { client, ...details }) => ({ project: await createProject(user, details, client) }),
  },
  {
    name: 'create_master_task', title: 'Add a project master task', write: true,
    description: 'Add a master task without creating a dated occurrence. Use frequency As needed for on-demand work. Enter time estimates in weeklyHours (for example 3 h weekly); omit it if the task has no separate allocation.',
    inputSchema: {
      client: id, project: id, title: z.string().trim().min(1).max(180), frequency: z.string().trim().min(1).max(100).optional(),
      weeklyHours: z.string().trim().max(100).optional(), executionDay: z.string().trim().max(100).optional(),
      notes: z.string().max(3000).optional(), responsibleUser: id.optional(),
    },
    run: async (user, { client, project, ...task }) => ({ masterTask: await createMasterTask(user, client, project, task) }),
  },
  {
    name: 'create_recurring_task', title: 'Create a recurring task template', write: true,
    description: 'Create a dated recurring template. Weekly needs a weekday (0 Sunday through 6 Saturday), monthly needs a day of the month, and semimonthly needs two dates. Semimonthly means twice per month. Omit assignees to leave the schedule unassigned. Provide masterItem to link an existing master task from the same project.',
    inputSchema: {
      client: id, project: id.optional(), masterItem: id.optional(), title: z.string().trim().min(1).max(230),
      assignees: ids.optional(), frequency: z.enum(['daily', 'weekly', 'monthly', 'semimonthly']),
      weekday: z.number().int().min(0).max(6).optional(),
      monthDay: z.number().int().min(1).max(31).optional(),
      monthDays: z.array(z.number().int().min(1).max(31)).length(2).optional(),
      startsOn: date.optional(), priority: priority.optional(), sop: z.string().max(3000).optional(),
      checklist: z.array(z.string().trim().min(1).max(300)).max(25).optional(),
    },
    run: (user, { startsOn, ...body }) => createRecurringTask(user, { ...body, startsOn: startsOn && dateValue(startsOn) }),
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
      if (!Object.keys(body).length) throw new HttpError(400, 'Provide at least one field to update');
      return { task: await updateTask(user, taskId, body) };
    },
  },
  {
    name: 'delete_task', title: 'Remove one task occurrence', destructive: true,
    description: 'Super Admin only. Remove one scheduled task occurrence by exact ID using Workflow soft deletion. Ask the user to confirm the individual task before calling. Recurring schedules and Daily Work submissions are separate.',
    inputSchema: { taskId: id },
    run: (user, { taskId }) => deleteTask(user, taskId),
  },
  {
    name: 'preview_daily_work_cleanup', title: 'Preview Daily Work activity cleanup',
    description: 'Super Admin only. List saved Daily Work submissions targeted for removal by exact employee IDs and inclusive historical work dates in IST. Use the counts and dates to obtain the user’s explicit confirmation before deletion.',
    inputSchema: cleanupSelection,
    run: previewDailyWorkCleanup,
  },
  {
    name: 'delete_daily_work_activity', title: 'Remove historical Daily Work activity',
    destructive: true,
    description: 'Super Admin only. After preview_daily_work_cleanup and explicit user confirmation of the members and dates, remove those Daily Work submissions from active views. Requires a matching preview token. Workflow keeps a recovery copy. Scheduled tasks, recurring templates, and existing Slack posts are unaffected.',
    inputSchema: { ...cleanupSelection, confirmationToken: z.string().regex(/^[0-9a-f]{64}$/) },
    run: (user, { confirmationToken, ...selection }) => deleteDailyWorkActivity(user, selection, confirmationToken),
  },
];

function mcpServer(auth, resourceMetadataUrl) {
  const server = new McpServer({ name: 'gatp-workflow', version: '1.0.0' });
  for (const tool of tools) {
    const scope = tool.destructive ? DELETE : tool.write ? WRITE : READ;
    const securitySchemes = [{ type: 'oauth2', scopes: [scope] }];
    server.registerTool(tool.name, {
      title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: scope === READ, destructiveHint: !!tool.destructive, openWorldHint: false },
      _meta: { securitySchemes },
    }, async (args) => {
      if (!auth?.scopes.includes(scope)) {
        return {
          isError: true,
          content: [{ type: 'text', text: scope === DELETE ? 'Reconnect as a Super Admin and explicitly grant delete access.' :
            scope === WRITE ? 'Connect with read and write access to perform this action.' : 'Connect your Workflow account.' }],
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

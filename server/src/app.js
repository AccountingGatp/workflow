import 'dotenv/config';
import express from 'express';
import { workflowMcpRouter } from './mcp/index.js';
import cors from 'cors';
import mongoose from 'mongoose';
import { ah, enforceWorkReadOnly, requireAuth, requireRole } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import peopleRoutes, { updatePersonLeave } from './routes/people.js';
import clientRoutes from './routes/clients.js';
import dailyWorkRoutes from './daily-work/routes.js';
import { runDailyWorkJobs } from './daily-work/jobs.js';
import workRoutes from './routes/work.js';
import projectRoutes from './routes/projects.js';
import projectWorkRoutes from './routes/project-work.js';
import mailRoutes, { mailPublic } from './routes/mail.js';
import { mailEnabled, setMailEnabled, requireMailEnabled } from './services/mail-settings.js';
import { syncAllAccounts } from './services/gmail.js';
import { generateRecurringTasks } from './services/recurrence.js';
import { detachBluntdRecurringLinks } from './detach-bluntd-recurring-links.js';
import { assignLoanTasks } from './assign-loan-reviewers.js';
import { seedLoanReminders } from './seed-loan-reminders.js';
import { seedIfEmpty } from './seed.js';
import { importProjectManagerRoster } from './project-manager-roster.js';
import { importWorkflowProjects } from './import-workflow-projects.js';
import { importProjectAssignments } from './import-project-assignments.js';
import { importTaskAutomation } from './import-task-automation.js';
import { importProjectTaskList } from './import-project-task-list.js';
import { User, ensureActivityRetention } from './models/index.js';
import { demoLoginEnabled, emailLoginConfigured } from './services/email-login.js';

async function connect() {
  let uri = process.env.MONGODB_URI;
  if (!uri) {
    if (process.env.VERCEL) throw new Error('MONGODB_URI is not set in the Vercel project settings');
    // No database configured: run an in-memory MongoDB so the app works out of the box.
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const mem = await MongoMemoryReplSet.create({
      replSet: { count: 1, args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] },
    });
    uri = mem.getUri('workflow');
    console.log('⚠  MONGODB_URI not set — using a temporary in-memory MongoDB (data resets on restart).');
  }
  const dbName = process.env.WORKFLOW_MONGODB_DB_NAME;
  await mongoose.connect(uri, dbName ? { dbName } : {});
  await ensureActivityRetention();
  console.log('✓ MongoDB connected; Activity Log retention: 7 days');
  await seedIfEmpty();
  const managersImported = await importProjectManagerRoster();
  if (managersImported) console.info('Project managers imported:', managersImported);
  const loanImport = await seedLoanReminders();
  console.info('Bluntd loan reminder import:', loanImport);
  console.info('Bluntd loan assignments:', await assignLoanTasks());
  const detached = await detachBluntdRecurringLinks();
  if (detached !== null) console.info('Bluntd recurring links detached:', detached);
  await User.updateMany({
    email: { $in: ['krupali.s@gatpsolutions.com', 'sathya.p@gatpsolutions.com'] },
    deletedAt: null, directAssignmentsPaused: { $exists: false },
  }, { $set: { directAssignmentsPaused: true } });
}

// Connect once per process; serverless invocations reuse the same connection while warm.
let readyPromise;
export function ready() {
  readyPromise ??= connect().catch((e) => { readyPromise = undefined; throw e; });
  return readyPromise;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(workflowMcpRouter());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({ demo: demoLoginEnabled(), emailLoginConfigured: emailLoginConfigured(), googleSignInClientId: process.env.GOOGLE_SIGN_IN_CLIENT_ID || null }));

// Background jobs, called by Vercel Cron (see vercel.json). Vercel sends CRON_SECRET as a bearer token.
const cronAuth = (req, res, next) => (process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` ? next() : res.status(401).json({ error: 'Unauthorized' }));
app.get('/api/cron/recurring', cronAuth, async (_req, res) => res.json({ created: await generateRecurringTasks() }));
app.get('/api/cron/mail', cronAuth, async (_req, res) => { await syncAllAccounts(); res.json({ ok: true }); });

app.get('/api/cron/daily-work', cronAuth, async (_req, res) => {
  const projectImport = process.env.WORKFLOW_PROJECT_IMPORT;
  if (projectImport) {
    try {
      const counts = await importWorkflowProjects(projectImport);
      if (counts) console.info('Workflow project import completed', counts);
    } catch (error) {
      console.error('Workflow project import failed', error.code || error.name);
    }
  }
  const taskImport = process.env.WORKFLOW_PROJECT_TASK_IMPORT;
  if (taskImport) {
    try {
      const counts = await importProjectTaskList(taskImport);
      if (counts) console.info('Workflow project task import completed', counts);
    } catch (error) {
      console.error('Workflow project task import failed', error.code || error.name);
    }
  }
  const assignments = process.env.WORKFLOW_PROJECT_ASSIGNMENT_IMPORT;
  if (assignments) {
    try {
      const result = await importProjectAssignments(assignments);
      if (result) console.info('Workflow project assignment import completed', JSON.stringify(result));
    } catch (error) {
      console.error('Workflow project assignment import failed', error.code || error.name);
    }
  }
  const automationImport = process.env.WORKFLOW_TASK_AUTOMATION_IMPORT;
  if (automationImport) {
    try {
      const counts = await importTaskAutomation(automationImport);
      if (counts) console.info('Workflow task automation import completed', JSON.stringify(counts));
    } catch (error) {
      console.error('Workflow task automation import failed', error.code || error.name);
    }
  }
  await runDailyWorkJobs();
  console.info('Daily Work cron finished');
  res.json({ ok: true });
});
app.use('/api/daily-work', requireAuth, dailyWorkRoutes);

app.use('/api/auth', authRoutes);
app.get('/api/settings/mail', requireAuth, ah(async (_req, res) => res.json({ enabled: await mailEnabled() })));
app.put('/api/settings/mail', requireAuth, requireRole('super_admin'), ah(async (req, res) => {
  res.json({ enabled: await setMailEnabled(req.body?.enabled) });
}));
app.use('/api/mail', requireMailEnabled);
app.use('/api', mailPublic);
app.put('/api/users/:id/leave', requireAuth, requireRole('super_admin', 'hr'), updatePersonLeave);
app.use('/api', requireAuth, enforceWorkReadOnly, peopleRoutes, clientRoutes, projectRoutes, projectWorkRoutes, workRoutes, mailRoutes);

export function handleErrors(app) {
  app.use((err, _req, res, _next) => {
    if (err.code === 11000) return res.status(409).json({ error: 'A record already exists for those details. Refresh and choose a different name or date.' });
    if (err.name === 'VersionError') return res.status(409).json({ error: 'Task changed. Refresh and try again.' });
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
  });
}

export default app;

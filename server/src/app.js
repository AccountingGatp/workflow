import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import peopleRoutes from './routes/people.js';
import clientRoutes from './routes/clients.js';
import workRoutes from './routes/work.js';
import projectRoutes from './routes/projects.js';
import projectWorkRoutes from './routes/project-work.js';
import mailRoutes, { mailPublic } from './routes/mail.js';
import { syncAllAccounts } from './services/gmail.js';
import { generateRecurringTasks } from './services/recurrence.js';
import { seedIfEmpty } from './seed.js';
import { seedRepublicProjects } from './seed-projects.js';
import { seedBluntdWorkItems } from './seed-bluntd-work.js';
import { ensureActivityRetention } from './models/index.js';

async function connect() {
  let uri = process.env.MONGODB_URI;
  if (!uri) {
    if (process.env.VERCEL) throw new Error('MONGODB_URI is not set in the Vercel project settings');
    // No database configured: run an in-memory MongoDB so the app works out of the box.
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mem = await MongoMemoryServer.create();
    uri = mem.getUri('workflow');
    console.log('⚠  MONGODB_URI not set — using a temporary in-memory MongoDB (data resets on restart).');
  }
  await mongoose.connect(uri);
  await ensureActivityRetention();
  console.log('✓ MongoDB connected; Activity Log retention: 7 days');
  await seedIfEmpty();
  await seedRepublicProjects();
  await seedBluntdWorkItems();
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

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({ demo: process.env.SEED_DEMO === 'true' }));

// Background jobs, called by Vercel Cron (see vercel.json). Vercel sends CRON_SECRET as a bearer token.
const cronAuth = (req, res, next) => (process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` ? next() : res.status(401).json({ error: 'Unauthorized' }));
app.get('/api/cron/recurring', cronAuth, async (_req, res) => res.json({ created: await generateRecurringTasks() }));
app.get('/api/cron/mail', cronAuth, async (_req, res) => { await syncAllAccounts(); res.json({ ok: true }); });

app.use('/api/auth', authRoutes);
app.use('/api', mailPublic);
app.use('/api', requireAuth, peopleRoutes, clientRoutes, projectRoutes, projectWorkRoutes, workRoutes, mailRoutes);

export function handleErrors(app) {
  app.use((err, _req, res, _next) => {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
  });
}

export default app;

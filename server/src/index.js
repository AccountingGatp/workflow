// Runs the API as a normal long-lived server (local development, or any always-on host).
// On Vercel, api/index.js serves the same app and Vercel Cron runs the background jobs.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import app, { ready, handleErrors } from './app.js';
import { startMailSync } from './services/gmail.js';
import { runDailyWorkJobs } from './daily-work/jobs.js';
import { startScheduler } from './services/recurrence.js';

const PORT = process.env.PORT || 4000;

// Serve the built client in production
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
handleErrors(app);

await ready();
startScheduler();
startMailSync();
const dailyWorkTick = () => runDailyWorkJobs().catch((error) => console.error('Daily Work jobs:', error.message));
dailyWorkTick();
setInterval(dailyWorkTick, 60000).unref();
app.listen(PORT, () => console.log(`✓ API on http://localhost:${PORT}`));

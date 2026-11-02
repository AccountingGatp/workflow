// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
import app, { ready, handleErrors } from '../server/src/app.js';

handleErrors(app);

export default async function handler(req, res) {
  await ready();
  return app(req, res);
}

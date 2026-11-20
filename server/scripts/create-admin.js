// Create (or promote) a Super Admin directly in the database.
// Usage: npm run create-admin -- --email you@firm.com --name "Your Name"
import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from '../src/models/index.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : undefined; };
const email = arg('email')?.trim().toLowerCase();
const name = arg('name') || 'Super Admin';

if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI in server/.env first.'); process.exit(1); }
if (!email) { console.error('Usage: npm run create-admin -- --email you@firm.com --name "Your Name"'); process.exit(1); }

await mongoose.connect(process.env.MONGODB_URI);
const user = await User.findOneAndUpdate(
  { email },
  { $set: { role: 'super_admin', active: true }, $setOnInsert: { name, title: 'Owner' } },
  { upsert: true, new: true },
);
console.log(`✓ Super Admin ready: ${user.name} <${user.email}>`);
await mongoose.disconnect();

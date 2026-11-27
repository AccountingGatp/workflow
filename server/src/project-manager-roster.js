import { ClientProject } from './models/index.js';

const roster = [
  ["6aec5d52b35e33f721f6fd12","Palak"], // Bluntd
  ["6aec5d52b35e33f721f6fd13","Palak"], // Bravura
  ["6afff709dd2acbc38db65c1a","Palak"], // Original Internal Accounting
  ["6afff704dd2acbc38db65bce","Palak"],
  ["6afff704dd2acbc38db65bd0","Anjali"],
  ["6afff705dd2acbc38db65bd2","Anjali"],
  ["6afff705dd2acbc38db65bd4","Simran"],
  ["6afff705dd2acbc38db65bd6","Anjali"],
  ["6afff705dd2acbc38db65bd8","Palak"],
  ["6afff705dd2acbc38db65bda","Palak"],
  ["6afff705dd2acbc38db65bdc","Palak"],
  ["6afff705dd2acbc38db65bde","Simran"],
  ["6afff705dd2acbc38db65be0","Simran"],
  ["6afff706dd2acbc38db65be2","Palak"],
  ["6afff706dd2acbc38db65be4","Hitesh"],
  ["6afff706dd2acbc38db65be6","Simran"],
  ["6afff706dd2acbc38db65be8","Hitesh"],
  ["6afff706dd2acbc38db65bea","Hitesh"],
  ["6afff706dd2acbc38db65bec","Palak"],
  ["6afff706dd2acbc38db65bee","Hitesh"],
  ["6afff706dd2acbc38db65bf0","Hitesh"],
  ["6afff707dd2acbc38db65bf2","Simran"],
  ["6afff707dd2acbc38db65bf4","Simran"],
  ["6afff3d71cb96c52e8233c74","Anjali"],
  ["6b051576604f7a8982b222cc","Simran"],
  ["6afff707dd2acbc38db65bf8","Simran"],
  ["6b03bd3ff74dece4a3f36902","Anjali"],
  ["6afff707dd2acbc38db65bfa","Simran"],
  ["6afff707dd2acbc38db65bfc","Simran"],
  ["6b03df34de037de705e259b1","Simran"],
  ["6afff707dd2acbc38db65bfe","Hitesh"],
  ["6afff707dd2acbc38db65c00","Simran"],
  ["6b066454d8109f4170318ce3","Hitesh"],
  ["6b00490e862a70a905e8679c","Hitesh"],
  ["6affec83763f1cacbcc36719","Palak"],
  ["6afff708dd2acbc38db65c02","Hitesh"],
  ["6afff708dd2acbc38db65c04","Hitesh"],
  ["6afff708dd2acbc38db65c06","Palak"],
  ["6afff708dd2acbc38db65c08","Simran"],
  ["6afff708dd2acbc38db65c0a","Anjali"],
  ["6afff708dd2acbc38db65c0c","Hitesh"],
  ["6afff708dd2acbc38db65c0e","Palak"],
  ["6afff3e31cb96c52e8233c77","Hitesh"],
  ["6afff708dd2acbc38db65c10","Hitesh"],
  ["6b03c12dd2a5a0bd7a3aa9cc","Anjali"],
  ["6afff3ef87820376a56e62a1","Palak"],
  ["6afff709dd2acbc38db65c12","Hitesh"],
  ["6afff709dd2acbc38db65c1c","Palak"],
  ["6afff709dd2acbc38db65c14","Anjali"],
  ["6afff709dd2acbc38db65c16","Anjali"],
  ["6afff709dd2acbc38db65c18","Palak"],
  ["6afff3f91cb96c52e8233c7a","Palak"],
];

export async function importProjectManagerRoster() {
  const ids = roster.map(([project]) => project);
  const pending = new Set((await ClientProject.distinct('_id', {
    _id: { $in: ids }, deletedAt: null, projectManager: { $exists: false },
  })).map(String));
  if (!pending.size) return 0;
  const result = await ClientProject.bulkWrite(roster.filter(([project]) => pending.has(project)).map(([project, name]) => ({
    updateOne: {
      filter: { _id: project, deletedAt: null, projectManager: { $exists: false } },
      update: { $set: { projectManager: { name } } },
    },
  })));
  return result.modifiedCount;
}

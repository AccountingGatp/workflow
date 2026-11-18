import { HttpError } from '../middleware/auth.js';

export const hubstaffConfigured = () => !!(process.env.DAILY_WORK_HUBSTAFF_TOKEN && /^\d+$/.test(process.env.DAILY_WORK_HUBSTAFF_ORG || ''));

async function pages(path, params, field) {
  const rows = [];
  const projects = new Map();
  let cursor;
  do {
    const url = new URL(`https://api.hubstaff.com/v2/organizations/${process.env.DAILY_WORK_HUBSTAFF_ORG}/${path}`);
    url.search = new URLSearchParams({ ...params, page_limit: 500, ...(cursor && { page_start_id: cursor }) });
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${process.env.DAILY_WORK_HUBSTAFF_TOKEN}` },
      signal: AbortSignal.timeout(8500),
    }).catch(() => null);
    if (!response?.ok) throw new HttpError(502, 'Hubstaff could not return activity. Check the token and organization settings.');
    const data = await response.json();
    rows.push(...(data[field] || []));
    for (const project of data.projects || []) projects.set(String(project.id), project.name);
    const next = data.pagination?.next_page_start_id;
    if (next && next === cursor) throw new HttpError(502, 'Hubstaff returned an invalid activity page');
    cursor = next;
  } while (cursor);
  return { rows, projects };
}

export async function hubstaff(date, members) {
  if (!members.length) return [];
  const [daily, last] = await Promise.all([
    pages('activities/daily', { 'date[start]': date, 'date[stop]': date }, 'daily_activities'),
    pages('last_activities', { 'include[]': 'projects' }, 'last_activities'),
  ]);
  const totals = new Map();
  for (const entry of daily.rows) {
    const id = String(entry.user_id);
    totals.set(id, (totals.get(id) || 0) + entry.tracked);
  }
  const current = new Map(last.rows.map((entry) => [String(entry.user_id), entry]));
  return members.map(({ id, name, hubstaffUserId }) => {
    const latest = current.get(hubstaffUserId);
    return {
      id, name, hours: (totals.get(hubstaffUserId) || 0) / 3600,
      online: !!latest?.online,
      currentProject: latest?.online && latest.last_project_id
        ? last.projects.get(String(latest.last_project_id)) || `Project ${latest.last_project_id}`
        : null,
      lastActivity: latest?.last_client_activity,
    };
  });
}

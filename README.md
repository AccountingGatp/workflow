# Workflow

Work management for an accounting practice: **Users ↔ Teams ↔ Clients ↔ Tasks**, with role-based access and explicit per-client permissions.

**Stack:** React (Vite) · Node/Express · MongoDB (Mongoose) · JWT auth.
Document storage (Backblaze B2) and the client portal are the next phase and are not built yet.

## Run locally

```bash
npm run install:all
cp server/.env.example server/.env   # set MONGODB_URI, or leave empty for a temporary in-memory DB
npm run dev:server                   # API on :4000 (seeds demo data on first run)
npm run dev:client                   # UI on :5173
```

## First login on a real database

1. In `server/.env` set `MONGODB_URI` (e.g. MongoDB Atlas), a long random `JWT_SECRET`, and
   `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (8+ characters). Keep `SEED_DEMO=false`.
2. Start the server. On an empty database it creates that person as the first **Super Admin**.
   Then remove `ADMIN_PASSWORD` from `.env`.
3. Sign in, then from the app: **Teams** → create teams → **People** → add Admins and Employees →
   add them to teams (choose a Lead) → **Clients** → create clients and assign teams/admins →
   on each client, **Grant** access to employees.

Locked out, or need another Super Admin? Run from `server/`:

```bash
npm run create-admin -- --email you@firm.com --name "Your Name" --password "a-strong-password"
```

It creates the user, or promotes an existing one and resets their password.

## Deploy on Vercel

The whole app (website + API) runs on one Vercel project; no other host is needed.
`api/index.js` serves the API as a serverless function, and Vercel Cron (in `vercel.json`)
syncs Gmail every 5 minutes and creates recurring tasks every hour. Cron needs a Pro plan.

1. MongoDB Atlas → Network Access → allow `0.0.0.0/0`.
2. Vercel → Add New → Project → import this repo. Leave **Root Directory** as the repo root;
   the settings come from `vercel.json`.
3. Environment variables: `MONGODB_URI`, `JWT_SECRET`, `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
   `SEED_DEMO=false`, and `CRON_SECRET` (any long random string).
   For Mail also add the Google ones and set `GOOGLE_REDIRECT_URI=https://<your-domain>/api/mail/oauth/callback`
   and `CLIENT_URL=https://<your-domain>`.
4. Deploy. Every push to `main` redeploys automatically.

## Demo data

Set `SEED_DEMO=true` to fill an empty database with demo data. Demo accounts (password `demo1234`): `owner@` (Super Admin), `anita@` / `rahul@` / `sneha@` (Admin/TL),
`amit@`, `neha@`, `karan@`, `pooja@` (Employees) — all `@demo.test`. Buttons on the login screen sign in directly.

## Access model

| Role | Sees |
|---|---|
| Super Admin | Every team, client, person and task |
| Admin / TL | The clients of the team they lead (plus any client they're added to as an extra manager), and all work on them |
| Employee | Only clients they have access to, and the tasks assigned to them |

How it works (enforced server-side in `server/src/services/access.js`):

- **Each team has exactly one TL / manager**, chosen when the team is created (changeable by a Super Admin).
- A client is assigned to a team, so the team's TL manages it automatically.
- When a TL assigns a task to someone in their team, that person gets access to the client automatically.
  Being in a team alone does not show someone every client of the team.
- The TL's home page shows **Team work**: every task for their clients, who it is assigned to, checklist progress,
  and who completed it. Completed tasks stay visible for 7 days (and always under the "Completed" filter).
- Giving access to someone outside your own team becomes an **access request** that a Super Admin approves.
- Access can be temporary (`expiresAt`).
- Removing a person closes their account and removes their team and client access; their name stays on past tasks.
  A TL can't be removed until their team has a new TL.
- The activity log records logins, access changes and task updates, and **entries are deleted automatically after 30 days**.

## Collections

`users`, `teams`, `team_memberships`, `clients`, `client_assignments`, `client_permissions`, `access_requests`,
`tasks`, `task_templates`, `audit_logs`. (`documents` arrives with the document-storage phase.)

## Mail (Gmail)

Mail follows client access: everyone with access to a client handles its email. Untagged email is visible only to the
Owner and the TL of the inbox's team. Staff replies wait for TL review; the client's TL and the Owner send directly.
Emails are stored as plain text, and attachments are listed by name only for now.

**Setup (Google Workspace admin):**

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Gmail API**.
2. Configure the OAuth consent screen with user type **Internal**, and add the scopes `gmail.readonly` and `gmail.send`.
3. Create an **OAuth client ID** of type *Web application*. Add the redirect URI from `GOOGLE_REDIRECT_URI`.
4. Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `MAIL_TOKEN_KEY` in `server/.env`, then restart.
5. As Super Admin, open **Mail → Inboxes → Connect Gmail inbox** and sign in as that mailbox.
6. On each client's page, add its email addresses or domains so mail is tagged automatically.

**Try it without Google:** run `node scripts/fake-gmail.js` from `server/` (settings are at the top of that file).
With a fresh database, `bash scripts/test-mail.sh` runs the full access and review test against it.

## Scheduling and completion review

Super Admins can edit client/company details from **Edit client / company**, edit project names from **Edit project**, and delete individual task occurrences from the task drawer. Deleting an occurrence leaves a cancellation record so the scheduler will not recreate it. Cancel a recurring schedule from **Recurring work** to stop future occurrences.

Client managers and team leaders can create tasks, edit a task's title and due date in its drawer, and maintain recurring schedules. Weekly schedules select a weekday; monthly schedules select day 1–31; **Twice monthly (two dates)** selects two different dates each month, rather than every 14 days. Dates beyond the end of a month run on that month's last day. Existing server calendar/timezone behavior is retained.

Assigned employees complete the checklist and submit work for review. It stays open as **Awaiting TL confirmation** until the team leader ticks the confirmation checkbox and confirms completion. The employee, reviewer and timestamps are recorded. A user cannot approve their own submission. Managers can return work to the employee. Changing approved work reopens it for review. Existing completed history is preserved.

A one-time, resumable import adds four Bluntd loan reminders from the November 13 screenshots: Auto Loan Mercedes on the 12th (Sathya Priya; reviewer Krupali), and First insurance funding, Ford van, and TD Auto finance on the 20th (Sathya Priya; reviewer Krupali). Screenshot last-paid dates are historical references only. The import uses existing accounts/project, never creates people or changes existing schedules, and does not recreate reminders after they are cancelled.

Validation: `npm test --prefix server` (temporary MongoDB for API tests), `npm run build --prefix client`, and `npm run lint --prefix client`. If your environment cannot run the default bundled MongoDB binary, set `MONGOMS_VERSION` to a supported MongoDB version.

Loan reminders now have a designated reviewer (Krupali). They appear in the reviewer’s My Work as well as the employee’s. Only the designated team leader may confirm these employee tasks. A follow-up import updates the existing loan schedules and open occurrences without changing completed history.

Employee completion review: employee work is submitted to its team leader; Sathya Priya’s current and newly assigned work routes to Krupali. Team leaders and admins complete their own assigned tasks directly with no reviewer or further approval. Super Admins manage tasks but do not confirm employee reviews. Existing completed history is kept.

## Daily Work

Open **Daily Work** from the Workflow sidebar. Each person submits their own daily entry and can edit or remove those tasks in **Projects by Member**. The reports show entries within the viewer's Workflow access. Only Super Admins can use **Manage Data** to configure projects, work distribution, report enrollment, shifts, leave, and the first reporting date. Use the existing **People** page to create Workflow accounts.

- Daily Work creates its own MongoDB collections on first use in `DAILY_WORK_DB_NAME` (default `workflow_daily_work`). The MongoDB account needs read/write and index permissions on that database. Use `DAILY_WORK_MONGODB_URI` for a separate cluster or database account. For a preview, use isolated MongoDB databases for both Workflow (`WORKFLOW_MONGODB_DB_NAME` or a separate `MONGODB_URI`) and Daily Work. Demo accounts belong in an isolated, protected preview.
- Active clients and their projects appear in Daily Work automatically according to each member's existing client access. Manage shared task definitions in **Clients → Project → Master Task List**. Daily Work shows that project’s searchable list of tasks and descriptions. Daily, weekly and monthly work can be logged on any work date in its period, using the same assigned occurrence across the period. Checking a step or submitting completion in Daily Work updates the same Workflow task; employee completion still goes to the team leader. Linked writes require Workflow and Daily Work to share the MongoDB connection so the task and daily entry save in one transaction.
- For Google sign-in, create a Web OAuth client for Google Identity Services, allow the exact frontend origin in its authorized JavaScript origins, and set `GOOGLE_SIGN_IN_CLIENT_ID` for that environment. Google sign-in links verified Workspace or Gmail identities to existing active Workflow accounts. Workflow roles and client permissions still apply.
- For Slack, set `DAILY_WORK_SLACK_TOKEN` to a bot token with `chat:write`, invite the bot to the channel and set `DAILY_WORK_SLACK_CHANNEL` to the channel ID. Use a dedicated test channel in preview. The first submission saves Slack's channel ID and thread timestamp. Later edits and deletions post the complete remaining daily entry in that thread. An edit with no saved original thread stays in Workflow. A delivery Slack explicitly rejects can be retried by the scheduler. An unconfirmed delivery is flagged to avoid a possible duplicate.
- Enable scheduled Slack reports using `DAILY_WORK_SLACK_REPORTS=true` and configure `CRON_SECRET` on Vercel. Morning reminders run at 10:00 IST, afternoon reminders at 15:30 IST, and the prior day's missing report at 01:00 IST. Default reporting days are Monday through Friday. The combined weekly report defaults to Friday at 18:00 IST and includes submitted days for enrolled members outside recorded leave. The incomplete report defaults to 18:15 IST and covers the past seven days. See `server/.env.example` for timing overrides. Vercel Cron runs on the production deployment.
- For Hubstaff, configure `DAILY_WORK_HUBSTAFF_ORG` and a read-capable organization access token or personal access token in `DAILY_WORK_HUBSTAFF_TOKEN`. A Super Admin maps each employee's Hubstaff user ID and grants tab access in **Manage Data**. The current project comes from the latest Hubstaff activity when the member is reported online.

### Daily Work hour limits and Review

Daily Work uses the hours and recurrence in the Clients task list when both are clear. A Super Admin can set or override daily, weekly, or monthly limits in Manage Data. Existing catalog hours default to a daily limit until changed. A weekly limit runs Monday through Sunday, and a monthly limit follows the calendar month. Daily Work applies the selected work date in IST. Limits are per employee and task. Changes and deletions recalculate availability from the saved entries.

Each Daily Work project receives a Review task automatically. The four eligible users are the unique active Admin/TL accounts whose first names are Simran, Krupali, Jaini, and Riddhi. Their Review limit is one hour per person per day across all projects. Daily Work uses MongoDB transactions to enforce hour limits across simultaneous saves, so the Daily Work database must be a replica set or a sharded cluster. Local demo mode starts a single-node replica set.

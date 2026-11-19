# Workflow

Work management for an accounting practice: **Users ↔ Teams ↔ Clients ↔ Tasks**, with role-based access and explicit per-client permissions.

**Stack:** React (Vite) · Node/Express · MongoDB (Mongoose) · email verification and revocable sessions.
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
   `ADMIN_NAME` and `ADMIN_EMAIL`. Keep `SEED_DEMO=false`.
2. Start the server. On an empty database it creates that person as the first **Super Admin**.
3. Add `RESEND_API_KEY` and `LOGIN_EMAIL_FROM` for a sender on a domain verified in Resend. Enter the registered email and verify the six-digit code. Codes expire in 10 minutes. Sessions survive browser restarts, renew with use, and expire after one year of inactivity.
4. From the app: **Teams** → create teams → **People** → add Admins and Employees with their sign-in email →
   add them to teams (choose a Lead) → **Clients** → create clients and assign teams/admins →
   on each client, **Grant** access to employees.

Locked out, or need another Super Admin? Run from `server/`:

```bash
npm run create-admin -- --email you@firm.com --name "Your Name"
```

It creates or promotes a user to Super Admin.

## Deploy on Vercel

The whole app (website + API) runs on one Vercel project; no other host is needed.
`api/index.js` serves the API as a serverless function, and Vercel Cron (in `vercel.json`)
syncs Gmail every 5 minutes and creates recurring tasks every hour. Cron needs a Pro plan.

1. MongoDB Atlas → Network Access → allow `0.0.0.0/0`.
2. Vercel → Add New → Project → import this repo. Leave **Root Directory** as the repo root;
   the settings come from `vercel.json`.
3. Environment variables: `MONGODB_URI`, `JWT_SECRET`, `ADMIN_NAME`, `ADMIN_EMAIL`, `RESEND_API_KEY`, `LOGIN_EMAIL_FROM`,
   `SEED_DEMO=false`, and `CRON_SECRET` (any long random string).
   For Mail also add the Google ones and set `GOOGLE_REDIRECT_URI=https://<your-domain>/api/mail/oauth/callback`
   and `CLIENT_URL=https://<your-domain>`.
4. Deploy. Every push to `main` redeploys automatically.

## Demo data

Set `SEED_DEMO=true` to fill an empty database with demo data. Local development offers demo sign-in buttons for the `@demo.test` accounts. Demo sign-in is disabled on Vercel and in production mode.

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
With a fresh local database and `SEED_DEMO=true`, `bash scripts/test-mail.sh` runs the access and review test.

## Scheduling and task completion

Team Leads and managers can edit client details, projects, tasks, assignments, and recurring schedules for clients they manage. Super Admins can delete task occurrences. Weekly schedules use a weekday. Monthly schedules use a calendar date. Twice-monthly schedules use two dates. If a month has fewer days, the occurrence runs on its last day.

Assignees can mark tasks complete after finishing the checklist. Older tasks pending confirmation can be completed from the same task controls. The Activity Log shows task additions and detail edits.

The Bluntd loan reminders assign the Auto Loan Mercedes task on the 12th and three additional loan tasks on the 20th to Sathya Priya.

Validation: `npm test --prefix server` and `npm run build --prefix client`. If the bundled MongoDB binary cannot run in your environment, set `MONGOMS_VERSION` to a supported version.

## Daily Work

Open **Daily Work** from the Workflow sidebar. Each person submits their own daily entry and can edit or remove those tasks in **Projects by Member**. The reports show entries within the viewer's Workflow access. Only Super Admins can use **Manage Data** to configure projects, work distribution, report enrollment, shifts, leave, and the first reporting date. Use the existing **People** page to create Workflow accounts.

- Daily Work creates its own MongoDB collections on first use in `DAILY_WORK_DB_NAME` (default `workflow_daily_work`). The MongoDB account needs read/write and index permissions on that database. Use `DAILY_WORK_MONGODB_URI` for a separate cluster or database account. For a preview, use isolated MongoDB databases for both Workflow (`WORKFLOW_MONGODB_DB_NAME` or a separate `MONGODB_URI`) and Daily Work. Demo accounts belong in an isolated, protected preview.
- Active clients and their projects appear in Daily Work automatically according to each member's existing client access. Manage shared task definitions in **Clients → Project → Master Task List**. Daily Work shows that project’s searchable list of tasks and descriptions. Daily, weekly and monthly work can be logged on any work date in its period, using the same assigned occurrence across the period. Checking a step or submitting completion in Daily Work updates the same Workflow task; employee completion still goes to the team leader. Linked writes require Workflow and Daily Work to share the MongoDB connection so the task and daily entry save in one transaction.
- For Google sign-in, create a Web OAuth client for Google Identity Services, allow the exact frontend origin in its authorized JavaScript origins, and set `GOOGLE_SIGN_IN_CLIENT_ID` for that environment. Google sign-in links verified Workspace or Gmail identities to existing active Workflow accounts. Workflow roles and client permissions still apply.
- For Slack, set `DAILY_WORK_SLACK_TOKEN` to a bot token with `chat:write`, invite the bot to the channel and set `DAILY_WORK_SLACK_CHANNEL` to the channel ID. To tag someone on their first Daily Work post, save their Slack member ID under People. Use a dedicated test channel in preview. The first submission saves Slack's channel ID and thread timestamp. Later edits and deletions post the complete remaining daily entry in that thread. An edit with no saved original thread stays in Workflow. A delivery Slack explicitly rejects can be retried by the scheduler. An unconfirmed delivery is flagged to avoid a possible duplicate.
- Enable shift-based reminders and the midnight incomplete report using `DAILY_WORK_SHIFT_REPORTS=true` and configure `CRON_SECRET` on Vercel. Super Admins can set shift starts, reminder times, and reporting enrollment under People. Existing morning and afternoon enrollments default to 10:00 IST and 15:30 IST. Setting `DAILY_WORK_SLACK_REPORTS=true` also enables the prior day's 01:00 IST missing report and the weekly report. Default reporting days are Monday through Friday. The combined weekly report defaults to Friday at 18:00 IST and includes submitted days for enrolled members outside recorded leave. The incomplete report defaults to midnight IST and covers the previous work date, including any saved reasons. See `server/.env.example` for timing overrides. Vercel Cron runs on the production deployment.
- Super Admins can add, edit, or pause daily Slack reminders under Settings → Slack reminders. The default reminder posts at 18:35 IST with @channel. Messages use the configured Daily Work Slack channel, including on weekends.
- For Hubstaff, configure `DAILY_WORK_HUBSTAFF_ORG` and a read-capable organization access token or personal access token in `DAILY_WORK_HUBSTAFF_TOKEN`. A Super Admin maps each employee's Hubstaff user ID and grants tab access in **Manage Data**. The current project comes from the latest Hubstaff activity when the member is reported online.

### Daily Work hour limits and Review

Daily Work uses the hours and recurrence in the Clients task list when both are clear. A Super Admin can set or override daily, weekly, or monthly limits in Manage Data. Existing catalog hours default to a daily limit until changed. A weekly limit runs Monday through Sunday, and a monthly limit follows the calendar month. Daily Work applies the selected work date in IST. Limits are per employee and task. Changes and deletions recalculate availability from the saved entries.

Each Daily Work project receives a Review task automatically. The four eligible users are the unique active Admin/TL accounts whose first names are Simran, Krupali, Jaini, and Riddhi. Their Review limit is one hour per person per day across all projects. Daily Work uses MongoDB transactions to enforce hour limits across simultaneous saves, so the Daily Work database must be a replica set or a sharded cluster. Local demo mode starts a single-node replica set.

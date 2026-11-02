// A small stand-in for Google, for trying Mail without a Google account. Never used in production.
// Run: node scripts/fake-gmail.js  then set in server/.env:
//   GOOGLE_CLIENT_ID=fake  GOOGLE_CLIENT_SECRET=fake  MAIL_TOKEN_KEY=any-long-string
//   GOOGLE_AUTH_BASE=http://localhost:4900/auth
//   GOOGLE_TOKEN_URL=http://localhost:4900/token
//   GMAIL_API_BASE=http://localhost:4900/gmail/v1
// POST /add-mail {"from","subject","text"} delivers a new email; GET /sent lists what was sent.
import express from 'express';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const INBOX = process.env.FAKE_INBOX || 'accounts@firm.test';
const messages = [];
const sent = [];
let history = 100;
let seq = 0;

function add({ from, to = INBOX, subject, text, threadId, labelIds = ['INBOX'], headers = [] }) {
  seq += 1; history += 1;
  const m = {
    id: `m${seq}`, threadId: threadId || `t${seq}`, labelIds, historyId: String(history), snippet: text.slice(0, 80), internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<m${seq}@fake>` }, ...headers],
      body: { data: Buffer.from(text).toString('base64url'), size: text.length },
    },
  };
  messages.push(m);
  return m;
}

add({ from: 'J. Hamilton <accounts@hamilton.example>', subject: 'October bank statement', text: 'Hi team,\nPlease find the October statement attached. Can you confirm you received it?\n\nThanks' });
add({ from: 'New Person <someone@unknown.example>', subject: 'Quote for bookkeeping?', text: 'Hello, could you send me a quote?' });
add({ from: 'Spammer <x@spam.example>', subject: 'WIN NOW', text: 'spam', labelIds: ['SPAM'] });

app.get('/auth', (req, res) => {
  const u = new URL(req.query.redirect_uri);
  u.searchParams.set('code', 'fake-code');
  u.searchParams.set('state', req.query.state);
  res.redirect(u.toString());
});
app.post('/token', (req, res) => res.json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 }));

const auth = (req, res, next) => (req.headers.authorization === 'Bearer fake-access' ? next() : res.status(401).json({ error: { message: 'bad token' } }));
const g = express.Router();
g.use(auth);
g.get('/users/me/profile', (_req, res) => res.json({ emailAddress: INBOX, historyId: String(history) }));
g.get('/users/me/messages', (_req, res) => res.json({ messages: [...messages].reverse().map(({ id, threadId }) => ({ id, threadId })) }));
g.get('/users/me/messages/:id', (req, res) => {
  const m = messages.find((x) => x.id === req.params.id);
  return m ? res.json(m) : res.status(404).json({ error: { message: 'not found' } });
});
g.get('/users/me/history', (req, res) => {
  const start = Number(req.query.startHistoryId);
  res.json({ history: messages.filter((m) => Number(m.historyId) > start).map((m) => ({ messagesAdded: [{ message: { id: m.id } }] })), historyId: String(history) });
});
g.post('/users/me/messages/send', (req, res) => {
  const raw = Buffer.from(req.body.raw, 'base64url').toString('utf8');
  const [head, b64] = raw.split('\r\n\r\n');
  const header = (n) => head.match(new RegExp(`^${n}: (.*)$`, 'mi'))?.[1]?.trim();
  const text = Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString('utf8');
  const m = add({ from: header('From'), to: header('To'), subject: header('Subject'), text, threadId: req.body.threadId, labelIds: ['SENT'] });
  sent.push({ id: m.id, threadId: req.body.threadId, to: header('To'), subject: header('Subject'), inReplyTo: header('In-Reply-To'), text });
  res.json({ id: m.id, threadId: m.threadId });
});
app.use('/gmail/v1', g);

app.post('/add-mail', (req, res) => res.json(add(req.body)));
app.get('/sent', (_req, res) => res.json(sent));

app.listen(process.env.FAKE_PORT || 4900, () => console.log(`Fake Gmail on ${process.env.FAKE_PORT || 4900}, inbox ${INBOX}`));

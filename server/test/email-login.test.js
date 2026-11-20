import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app, { handleErrors } from '../src/app.js';
import { AuthSession, EmailCode, User } from '../src/models/index.js';

test('email verification, persistent cookie, and revocable sign-out', async () => {
  const database = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] } });
  const realFetch = globalThis.fetch;
  let server;
  try {
    await mongoose.connect(database.getUri('email_login_test'));
    process.env.RESEND_API_KEY = 'fixture';
    process.env.LOGIN_EMAIL_FROM = 'Workflow <login@example.test>';
    const mail = [];
    globalThis.fetch = (url, options) => {
      if (url !== 'https://api.resend.com/emails') return realFetch(url, options);
      mail.push(JSON.parse(options.body));
      return Promise.resolve(Response.json({ id: 'test-message' }));
    };
    await User.create({ name: 'Staff', email: 'staff@example.test' });
    handleErrors(app);
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const post = (route, body, cookie) => fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
      body: JSON.stringify(body),
    });
    const me = (cookie) => fetch(base + '/me', { headers: { cookie } });
    const email = 'staff@example.test';

    const unknown = await post('/email/request', { email: 'unknown@example.test' });
    assert.match((await unknown.json()).challenge, /^[a-f0-9]{48}$/);
    assert.equal(mail.length, 0);
    const requested = await post('/email/request', { email: ' STAFF@example.test ' });
    assert.equal(requested.status, 200);
    const { challenge } = await requested.json();
    assert.deepEqual(mail[0].to, [email]);
    const code = mail[0].text.match(/\b\d{6}\b/)[0];
    await post('/email/request', { email });
    assert.equal(mail.length, 1);
    const check = (value) => post('/email/verify', { email, challenge, code: value });
    assert.equal((await check(code === '000000' ? '000001' : '000000')).status, 401);
    const attempts = await Promise.all([check(code), check(code)]);
    assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 401]);
    const success = attempts.find((response) => response.ok);
    const cookieHeader = success.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /Max-Age=31536000/i);
    assert.equal((await success.json()).token, undefined);
    const cookie = cookieHeader.split(';')[0];
    assert.equal((await me(cookie)).status, 200);
    await AuthSession.updateOne({}, { $set: { expiresAt: new Date(Date.now() + 2 * 86400000) } });
    const reopened = await me(cookie);
    assert.match(reopened.headers.get('set-cookie'), /Max-Age=31536000/i);
    assert.equal((await post('/logout', {}, cookie)).status, 200);
    assert.equal((await me(cookie)).status, 401);
    assert.equal(await AuthSession.countDocuments(), 0);

    const second = await post('/email/request', { email });
    const fresh = await second.json();
    const freshCode = mail.at(-1).text.match(/\b\d{6}\b/)[0];
    await EmailCode.updateOne({ nonce: fresh.challenge }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    assert.equal((await post('/email/verify', { email, challenge: fresh.challenge, code: freshCode })).status, 401);
  } finally {
    globalThis.fetch = realFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await database.stop();
  }
});

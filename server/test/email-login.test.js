import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app, { handleErrors } from '../src/app.js';
import { JWT_SECRET } from '../src/middleware/auth.js';
import { AuthSession, EmailCode, User } from '../src/models/index.js';

test('email verification, persistent cookie, and revocable sign-out', async () => {
  const database = await MongoMemoryReplSet.create({ replSet: { count: 1, args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] } });
  const realFetch = globalThis.fetch;
  const realVerify = OAuth2Client.prototype.verifyIdToken;
  const googleClientId = process.env.GOOGLE_SIGN_IN_CLIENT_ID;
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

    const newEmail = 'new.person@gatpsolutions.com';
    const admin = await User.create({ name: 'Owner', email: 'owner@example.test', role: 'super_admin' });
    const employee = await User.findOne({ email });
    const workspaceApi = (path, actor, body) => fetch(base.replace(/\/auth$/, '') + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt.sign({ sub: String(actor._id) }, JWT_SECRET) },
      body: body && JSON.stringify(body),
    });
    const requests = '/sign-in-requests';
    const action = (address, decision) => `${requests}/${encodeURIComponent(address)}/${decision}`;
    process.env.GOOGLE_SIGN_IN_CLIENT_ID = 'test-google-client';
    let claims = { sub: 'test-person', email: newEmail, email_verified: true, hd: 'gatpsolutions.com', name: 'New Person' };
    OAuth2Client.prototype.verifyIdToken = async ({ audience }) => {
      assert.equal(audience, 'test-google-client');
      return { getPayload: () => claims };
    };
    async function googleSignIn() {
      const nonceResponse = await fetch(base + '/google/nonce');
      const { nonce } = await nonceResponse.json();
      claims = { ...claims, nonce };
      return post('/google', { credential: 'mock-google-token' }, nonceResponse.headers.get('set-cookie').split(';')[0]);
    }
    claims.hd = 'another-company.com';
    assert.equal((await googleSignIn()).status, 401);
    claims.hd = 'gatpsolutions.com';
    claims.email_verified = false;
    assert.equal((await googleSignIn()).status, 401);
    claims.email_verified = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = await googleSignIn();
      assert.equal(pending.status, 202);
      assert.equal(pending.headers.get('set-cookie'), null);
      assert.deepEqual(await pending.json(), { requestStatus: 'pending' });
    }
    assert.equal(await User.exists({ email: newEmail }), null);
    assert.equal(await AuthSession.countDocuments(), 0);
    assert.equal((await workspaceApi(requests, employee)).status, 403);
    assert.equal((await workspaceApi(action(newEmail, 'approve'), employee, {})).status, 403);
    const { pending } = await (await workspaceApi(requests, admin)).json();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]._id, newEmail);
    assert.equal(pending[0].name, 'New Person');
    const approved = await workspaceApi(action(newEmail, 'approve'), admin, {
      name: 'Updated Name', title: 'Bookkeeper', slackUserId: 'u012abc', role: 'super_admin',
    });
    assert.equal(approved.status, 200);
    assert.equal((await workspaceApi(action(newEmail, 'approve'), admin, {})).status, 409);
    const newUser = await User.findOne({ email: newEmail }).select('+slackUserId');
    assert.equal(newUser.name, 'Updated Name');
    assert.equal(newUser.title, 'Bookkeeper');
    assert.equal(newUser.slackUserId, 'U012ABC');
    assert.equal(newUser.role, 'employee');
    const signedIn = await googleSignIn();
    assert.equal(signedIn.status, 200);
    assert.equal((await signedIn.json()).user.email, newEmail);
    assert.equal((await me(signedIn.headers.get('set-cookie').split(', ').find((value) => value.startsWith('workflow_session')).split(';')[0])).status, 200);

    const disabledEmail = 'disabled@gatpsolutions.com';
    await User.create({ name: 'Disabled', email: disabledEmail, active: false });
    claims = { ...claims, email: disabledEmail, sub: 'disabled-person' };
    assert.equal((await googleSignIn()).status, 401);

    const codeEmail = 'email.only@gatpsolutions.com';
    const codeResponse = await post('/email/request', { email: codeEmail });
    const codeChallenge = (await codeResponse.json()).challenge;
    assert.deepEqual(mail.at(-1).to, [codeEmail]);
    const accessCode = mail.at(-1).text.match(/\b\d{6}\b/)[0];
    const codePending = await post('/email/verify', { email: codeEmail, challenge: codeChallenge, code: accessCode });
    assert.equal(codePending.status, 202);
    assert.deepEqual(await codePending.json(), { requestStatus: 'pending' });
    assert.equal((await workspaceApi(action(codeEmail, 'reject'), admin, {})).status, 200);
    claims = { ...claims, email: codeEmail, sub: 'rejected-person' };
    const denied = await googleSignIn();
    assert.equal(denied.status, 202);
    assert.deepEqual(await denied.json(), { requestStatus: 'rejected' });
    assert.equal(await User.exists({ email: codeEmail }), null);
  } finally {
    globalThis.fetch = realFetch;
    OAuth2Client.prototype.verifyIdToken = realVerify;
    if (googleClientId === undefined) delete process.env.GOOGLE_SIGN_IN_CLIENT_ID;
    else process.env.GOOGLE_SIGN_IN_CLIENT_ID = googleClientId;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await database.stop();
  }
});

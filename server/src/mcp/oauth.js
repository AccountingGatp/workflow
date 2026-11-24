import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { model, Schema } from 'mongoose';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ah, HttpError, requireAuth } from '../middleware/auth.js';
import { User } from '../models/index.js';

export const READ = 'workflow:read';
export const WRITE = 'workflow:write';
export const DELETE = 'workflow:delete';
const scopes = [READ, WRITE, DELETE];
const effectiveScopes = (user, granted) => granted.filter((scope) =>
  scope === READ || (scope === WRITE && user.role !== 'hr') || (scope === DELETE && user.role === 'super_admin'));
const randomToken = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const expiresIn = (seconds) => new Date(Date.now() + seconds * 1000);
const accessLifetime = 3600;
const grantLifetime = 30 * 86400;

const Client = model('WorkflowMcpClient', new Schema({
  _id: String, metadata: Schema.Types.Mixed, origin: String,
}));
const Authorization = model('WorkflowMcpAuthorization', new Schema({
  _id: String, clientId: String, origin: String, redirectUri: String, state: String,
  requested: [String], scopes: [String], challenge: String, codeHash: String,
  user: Schema.Types.ObjectId, email: String, expiresAt: { type: Date, expires: 0 },
}));
Authorization.schema.index({ codeHash: 1 }, { sparse: true, unique: true });
const Grant = model('WorkflowMcpGrant', new Schema({
  clientId: String, origin: String, user: Schema.Types.ObjectId, email: String, scopes: [String],
  accessHash: String, refreshHash: String, accessExpiresAt: Date, expiresAt: { type: Date, expires: 0 },
}, { timestamps: true }));
Grant.schema.index({ accessHash: 1 }, { unique: true });
Grant.schema.index({ refreshHash: 1 }, { unique: true });
Grant.schema.index({ user: 1, origin: 1 });

function permittedRedirect(value) {
  if (value === 'https://chatgpt.com/connector_platform_oauth_redirect') return true;
  if (/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(value)) return true;
  return (process.env.WORKFLOW_MCP_REDIRECT_URIS || '').split(',').some((uri) => uri.trim() === value);
}

const currentUser = (record) => User.findOne({
  _id: record.user, email: record.email, active: true, deletedAt: null,
});

function tokenPair() {
  const access = randomToken();
  const refresh = randomToken();
  return {
    update: { accessHash: hash(access), refreshHash: hash(refresh), accessExpiresAt: expiresIn(accessLifetime) },
    response: { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: accessLifetime },
  };
}

export function createWorkflowOAuth(origin) {
  const resource = new URL('/api/mcp', origin);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  function validateResource(value) {
    if (value && value.href !== resource.href) throw new InvalidRequestError('Invalid Workflow MCP resource');
  }

  const activeCode = (clientId, code) => ({
    clientId, origin, codeHash: hash(code), expiresAt: { $gt: new Date() },
  });

  const provider = {
    clientsStore: {
      async getClient(clientId) {
        const client = await Client.findOne({ _id: clientId, origin }).lean();
        if (!client || !client.metadata.redirect_uris.every(permittedRedirect)) return undefined;
        return client.metadata;
      },
      async registerClient(client) {
        if (!client.redirect_uris.length || client.redirect_uris.length > 4 || !client.redirect_uris.every(permittedRedirect)) {
          throw new InvalidClientMetadataError('Redirect URL is not approved for this Workflow deployment');
        }
        if (!['none', 'client_secret_post'].includes(client.token_endpoint_auth_method || 'client_secret_post')) {
          throw new InvalidClientMetadataError('Use none or client_secret_post for token authentication');
        }
        const metadata = {
          client_id: client.client_id, client_id_issued_at: client.client_id_issued_at,
          redirect_uris: client.redirect_uris, token_endpoint_auth_method: client.token_endpoint_auth_method || 'client_secret_post',
          client_secret: client.client_secret, client_secret_expires_at: client.client_secret_expires_at,
          response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
        };
        await Client.create({ _id: client.client_id, origin, metadata });
        return metadata;
      },
    },
    async authorize(client, params, res) {
      validateResource(params.resource);
      if (!client.redirect_uris.includes(params.redirectUri) || !/^[\w-]{43}$/.test(params.codeChallenge) ||
          (params.state && params.state.length > 1024)) throw new InvalidRequestError('Invalid OAuth request');
      if (params.scopes.some((scope) => !scopes.includes(scope))) throw new InvalidScopeError('Unknown Workflow scope');
      const requested = params.scopes.length ? [...new Set([READ, ...params.scopes])] : scopes;
      const id = randomToken();
      await Authorization.create({
        _id: id, clientId: client.client_id, origin, redirectUri: params.redirectUri, state: params.state,
        challenge: params.codeChallenge, requested, expiresAt: expiresIn(600),
      });
      res.set('Cache-Control', 'no-store').redirect(303, '/mcp-connect?request=' + id);
    },
    async challengeForAuthorizationCode(client, code) {
      const record = await Authorization.findOne(activeCode(client.client_id, code)).select('challenge').lean();
      if (!record) throw new InvalidGrantError('Authorization code expired or already used');
      return record.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, target) {
      validateResource(target);
      const request = await Authorization.findOneAndDelete({
        ...activeCode(client.client_id, code), redirectUri: redirectUri || client.redirect_uris[0],
      }).lean();
      const user = request && await currentUser(request);
      if (!user) throw new InvalidGrantError('Workflow approval is no longer valid');
      const pair = tokenPair();
      const selected = effectiveScopes(user, request.scopes);
      await Grant.create({
        clientId: client.client_id, origin, user: request.user, email: request.email,
        scopes: selected, expiresAt: expiresIn(grantLifetime), ...pair.update,
      });
      return { ...pair.response, scope: selected.join(' ') };
    },
    async exchangeRefreshToken(client, token, wanted, target) {
      validateResource(target);
      const filter = { clientId: client.client_id, origin, refreshHash: hash(token), expiresAt: { $gt: new Date() } };
      const grant = await Grant.findOne(filter).lean();
      const user = grant && await currentUser(grant);
      if (!user) throw new InvalidGrantError('Workflow connection expired or was revoked');
      const available = effectiveScopes(user, grant.scopes);
      const selected = wanted?.length ? [...new Set(wanted)] : available;
      if (!selected.includes(READ) || selected.some((scope) => !available.includes(scope))) {
        throw new InvalidScopeError('Requested scopes exceed the approved Workflow access');
      }
      const pair = tokenPair();
      const result = await Grant.updateOne(filter, { $set: { scopes: selected, ...pair.update } });
      if (!result.modifiedCount) throw new InvalidGrantError('Refresh token was already used');
      return { ...pair.response, scope: selected.join(' ') };
    },
    async verifyAccessToken(token) {
      if (!/^[\w-]{43}$/.test(token)) throw new InvalidTokenError('Invalid Workflow token');
      const now = new Date();
      const grant = await Grant.findOne({
        origin, accessHash: hash(token), accessExpiresAt: { $gt: now }, expiresAt: { $gt: now },
      }).lean();
      const user = grant && await currentUser(grant);
      if (!user) throw new InvalidTokenError('Workflow token expired or was revoked');
      return {
        token, clientId: grant.clientId, resource, expiresAt: Math.floor(+grant.accessExpiresAt / 1000),
        scopes: effectiveScopes(user, grant.scopes), extra: { user },
      };
    },
    async revokeToken(client, { token }) {
      const digest = hash(token);
      await Grant.deleteOne({ clientId: client.client_id, origin, $or: [{ accessHash: digest }, { refreshHash: digest }] });
    },
  };

  const router = Router();
  router.use(mcpAuthRouter({
    provider, issuerUrl: new URL(origin), resourceServerUrl: resource,
    resourceName: 'GATP Workflow', scopesSupported: scopes,
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));

  const pending = (id) => ({
    _id: /^[\w-]{43}$/.test(id || '') ? id : '',
    origin, codeHash: { $exists: false }, expiresAt: { $gt: new Date() },
  });
  const connection = (req) => ({ origin, user: req.user._id, email: req.user.email });
  const accountRoutes = Router();
  accountRoutes.use(requireAuth, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== origin) {
      return res.status(403).json({ error: 'Open Workflow directly to change MCP access' });
    }
    next();
  });
  accountRoutes.get('/', ah(async (req, res) => {
    const grants = await Grant.find({ ...connection(req), expiresAt: { $gt: new Date() } })
      .select('scopes createdAt expiresAt').sort('-createdAt').lean();
    res.json({ url: resource.href, grants: grants.map((grant) => ({ ...grant, scopes: effectiveScopes(req.user, grant.scopes) })) });
  }));
  accountRoutes.get('/consent/:id', ah(async (req, res) => {
    const request = await Authorization.findOne(pending(req.params.id)).lean();
    if (!request) throw new HttpError(404, 'This connection request expired. Start again in your MCP client.');
    const allowed = effectiveScopes(req.user, request.requested);
    res.json({ destination: new URL(request.redirectUri).hostname, allowWrite: allowed.includes(WRITE), allowDelete: allowed.includes(DELETE) });
  }));
  accountRoutes.post('/consent/:id', ah(async (req, res) => {
    const { access, allowDelete = false } = req.body || {};
    if (!['read', 'write', 'deny'].includes(access) || typeof allowDelete !== 'boolean') throw new HttpError(400, 'Choose an access level');
    const request = await Authorization.findOne(pending(req.params.id)).lean();
    if (!request || !permittedRedirect(request.redirectUri)) throw new HttpError(404, 'This connection request expired.');
    const url = new URL(request.redirectUri);
    if (request.state) url.searchParams.set('state', request.state);
    if (access === 'deny') {
      const result = await Authorization.deleteOne(pending(req.params.id));
      if (!result.deletedCount) throw new HttpError(409, 'This request has already been answered');
      url.searchParams.set('error', 'access_denied');
    } else {
      const selected = [READ, ...(access === 'write' ? [WRITE] : []), ...(allowDelete ? [DELETE] : [])];
      const available = effectiveScopes(req.user, request.requested);
      if (selected.some((scope) => !available.includes(scope))) {
        throw new HttpError(403, 'This account or connection request cannot grant the selected access');
      }
      const code = randomToken();
      const result = await Authorization.updateOne(pending(req.params.id), { $set: {
        user: req.user._id, email: req.user.email, scopes: selected,
        codeHash: hash(code), expiresAt: expiresIn(120),
      } });
      if (!result.modifiedCount) throw new HttpError(409, 'This request has already been answered');
      url.searchParams.set('code', code);
    }
    res.json({ returnTo: url.href });
  }));
  accountRoutes.delete('/:id', ah(async (req, res) => {
    await Grant.deleteOne({ ...connection(req), _id: req.params.id });
    res.json({ ok: true });
  }));
  router.use('/api/mcp-connections', accountRoutes);
  return { router, provider, resource, resourceMetadataUrl };
}

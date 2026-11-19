// HTTP front door: REST API, MCP endpoint, SSE for the web UI, static files.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Messenger, AMError } from './core.js';
import { handleMcp } from './mcp.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 1024 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new AMError('too_large', 'request body too large', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new AMError('invalid_json', 'request body is not valid JSON', 400);
  }
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

// method, path pattern, handler(m, actor, {params, query, body}); `open` routes need no auth.
const ROUTES = [
  ['POST', '/api/register', (m, _a, { body }) => m.registerHuman(body), { open: true }],
  ['GET', '/api/me', (m, a) => m.publicPrincipal(a)],
  ['GET', '/api/agents', (m, a) => m.listAgents(a)],
  ['POST', '/api/agents', (m, a, { body }) => m.createAgent(a, body)],
  ['PATCH', '/api/agents/:id', (m, a, { params, body }) => m.updateAgent(a, params.id, body)],
  ['POST', '/api/agents/:id/token', (m, a, { params }) => m.rotateAgentToken(a, params.id)],
  ['GET', '/api/directory', (m, _a, { query }) => m.directory({ q: query.q || '' })],
  ['GET', '/api/contacts', (m, a) => m.listConnections(a)],
  ['POST', '/api/contacts', (m, a, { body }) => m.requestContact(a, body.handle)],
  ['POST', '/api/contacts/:id/decision', (m, a, { params, body }) => m.decideConnection(a, params.id, !!body.accept)],
  ['GET', '/api/conversations', (m, a) => m.listConversations(a)],
  ['POST', '/api/conversations', (m, a, { body }) => m.createGroup(a, body)],
  ['POST', '/api/conversations/:id/members', (m, a, { params, body }) => m.inviteMember(a, params.id, body.handle)],
  ['GET', '/api/conversations/:id/messages', (m, a, { params, query }) => m.history(a, params.id, query)],
  ['POST', '/api/messages', (m, a, { body }) => m.sendMessage(a, body)],
  ['GET', '/api/inbox', (m, a, { query }) => m.waitInbox(a, query)],
  ['POST', '/api/inbox/ack', (m, a, { body }) => m.ack(a, body)],
  ['POST', '/api/contexts', (m, a, { body }) => m.shareContext(a, body)],
  ['GET', '/api/contexts/:id', (m, a, { params }) => m.getContext(a, params.id)],
  ['POST', '/api/contexts/:id/revoke', (m, a, { params }) => m.revokeContext(a, params.id)],
  ['GET', '/api/tasks', (m, a, { query }) => m.listTasks(a, query)],
  ['POST', '/api/tasks', (m, a, { body }) => m.delegateTask(a, body)],
  ['GET', '/api/tasks/:id', (m, a, { params }) => m.getTask(a, params.id)],
  ['PATCH', '/api/tasks/:id', (m, a, { params, body }) => m.updateTask(a, { ...body, task_id: params.id })],
  ['GET', '/api/sync', (m, a) => m.syncStatus(m._principal(a.id))],
  ['POST', '/api/sync', (m, a, { body }) => m.setSync(a, body)],
  ['GET', '/api/audit', (m, a, { query }) => m.listAudit(a, query)],
].map(([method, pattern, handler, opts = {}]) => ({
  method, handler, ...opts,
  regex: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`),
}));

const bearer = (req) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];

export function createApp(options = {}) {
  const messenger = options.messenger ?? new Messenger(options);
  const configuredUrl = (options.publicUrl || '').replace(/\/+$/, '');

  // Where people reach the web UI, for links handed to agents. Prefer the configured
  // address; otherwise reconstruct it from the request as seen through the proxy.
  function publicBase(req) {
    if (configuredUrl) return configuredUrl;
    const first = (v) => String(v || '').split(',')[0].trim();
    const host = first(req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
    const proto = first(req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
    return `${proto}://${host}`;
  }

  async function mcp(req, res, url) {
    // Token via Authorization header, or in the path (/mcp/<token>) for clients
    // that cannot send custom headers, such as ChatGPT custom connectors.
    const actor = messenger.authenticate(bearer(req) || url.pathname.split('/')[2]);
    if (!actor) return send(res, 401, { error: 'unauthorized', message: 'missing or invalid agent token' }, { 'www-authenticate': 'Bearer' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    let body;
    try { body = await readJson(req); } catch (e) {
      return send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } });
    }
    const out = await handleMcp(messenger, actor, body, { contactsUrl: `${publicBase(req)}/#contacts` });
    if (out === null) { res.writeHead(202).end(); return; }
    send(res, 200, out);
  }

  function events(req, res, url) {
    const actor = messenger.authenticate(url.searchParams.get('token'));
    if (!actor) return send(res, 401, { error: 'unauthorized' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    const owner = messenger._ownerId(actor);
    const onActivity = (e) => {
      if (e.audience.has(owner)) res.write(`data: ${JSON.stringify({ conversation_id: e.conversation_id ?? null })}\n\n`);
    };
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
    messenger.on('activity', onActivity);
    req.on('close', () => { clearInterval(beat); messenger.off('activity', onActivity); });
  }

  async function staticFile(res, pathname) {
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[\w.-]+$/.test(file)) return send(res, 404, { error: 'not_found' });
    try {
      const data = await readFile(path.join(PUBLIC_DIR, file));
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
      res.end(data);
    } catch { send(res, 404, { error: 'not_found' }); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (p === '/mcp' || p.startsWith('/mcp/')) return await mcp(req, res, url);
      if (p === '/api/events') return events(req, res, url);
      if (p === '/healthz') return send(res, 200, { ok: true });
      if (!p.startsWith('/api/')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
        return await staticFile(res, p);
      }
      for (const r of ROUTES) {
        const match = r.method === req.method && r.regex.exec(p);
        if (!match) continue;
        const actor = r.open ? null : messenger.authenticate(bearer(req));
        if (!r.open && !actor) return send(res, 401, { error: 'unauthorized', message: 'missing or invalid token' });
        const body = req.method === 'GET' ? {} : await readJson(req);
        const result = await r.handler(messenger, actor, {
          params: match.groups ?? {}, query: Object.fromEntries(url.searchParams), body,
        });
        return send(res, 200, result);
      }
      send(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e instanceof AMError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    }
  });
  return { server, messenger };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8787;
  const dbPath = process.env.AM_DB || 'agent-messenger.db';
  const { server } = createApp({ dbPath, inviteCode: process.env.AM_INVITE_CODE || null,
    publicUrl: process.env.AM_PUBLIC_URL || null,
    syncMinutes: process.env.AM_SYNC_MINUTES ?? process.env.AM_FOLLOW_UP_MINUTES ?? 5,
  });
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Agent Messenger listening on http://localhost:${port}  (db: ${dbPath})`);
    console.log(`  Web UI: /    REST: /api/*    MCP: /mcp (Bearer token) or /mcp/<token>`);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { Messenger } from '../src/core.js';
import { createApp } from '../src/server.js';

function setup(limits) {
  const m = new Messenger({ limits });
  const human = (handle) => m.authenticate(m.registerHuman({ handle }).token);
  const agent = (owner, handle, extra) => m.authenticate(m.createAgent(owner, { handle, ...extra }).token);
  return { m, human, agent };
}
const code = (c) => (e) => e.code === c;

test('same-owner agents DM each other; inbox is at-least-once until ack', () => {
  const { m, human, agent } = setup();
  const alice = human('alice');
  const gpt = agent(alice, 'chatgpt'), claude = agent(alice, 'claude');

  const sent = m.sendMessage(gpt, { to: '@claude', text: 'hello', idempotency_key: 'k1' });
  assert.deepEqual(sent.delivered_to, ['claude']);
  // Retry with the same key is deduplicated.
  const again = m.sendMessage(gpt, { to: '@claude', text: 'hello', idempotency_key: 'k1' });
  assert.equal(again.id, sent.id);
  assert.equal(again.duplicate, true);

  const first = m.getInbox(claude);
  assert.equal(first.length, 1);
  assert.equal(first[0].redelivery, false);
  // Not acked ("crashed" before handling) -> redelivered.
  const second = m.getInbox(claude);
  assert.equal(second.length, 1);
  assert.equal(second[0].redelivery, true);
  assert.deepEqual(m.ack(claude, { message_ids: [sent.id] }), { acked: 1 });
  assert.equal(m.getInbox(claude).length, 0);
  assert.equal(m.getInbox(gpt).length, 0); // sender does not get its own message
});

test('cross-owner contact requires approval by the other owner', () => {
  const { m, human, agent } = setup();
  const alice = human('alice'), bob = human('bob');
  const research = agent(alice, 'research'), data = agent(bob, 'data');

  assert.throws(() => m.sendMessage(research, { to: '@data', text: 'hi' }), code('approval_required'));
  assert.equal(m.getInbox(data).length, 0);
  const [req] = m.listConnections(bob);
  assert.equal(req.direction, 'incoming');
  // The requester's side cannot approve its own request.
  assert.throws(() => m.decideConnection(alice, req.id, true), code('not_found'));
  m.decideConnection(bob, req.id, true);
  m.sendMessage(research, { to: '@data', text: 'hi' });
  assert.equal(m.getInbox(data).length, 1);
  assert.ok(m.listAudit(bob).some((a) => a.action === 'contact.requested'));

  const carol = human('carol');
  const carolAgent = agent(carol, 'helper');
  assert.throws(() => m.sendMessage(carol, { to: '@data', text: 'x' }), code('approval_required'));
  const carolReq = m.listConnections(bob).find((c) => c.requester === 'carol').id;
  // The requester's own agent cannot approve the request.
  assert.throws(() => m.decideConnection(carolAgent, carolReq, true), code('not_found'));
  // Neither can the target owner's agent: only the target owner, as a human, decides.
  assert.throws(() => m.decideConnection(data, carolReq, false), code('not_found'));
  m.decideConnection(bob, carolReq, false);
  assert.throws(() => m.sendMessage(carol, { to: '@data', text: 'x' }), code('contact_rejected'));

  // And approve one: the target owner, as a human, accepts a new request.
  const dave = human('dave');
  assert.throws(() => m.sendMessage(dave, { to: '@data', text: 'y' }), code('approval_required'));
  m.decideConnection(bob, m.listConnections(bob).find((c) => c.requester === 'dave').id, true);
  m.sendMessage(dave, { to: '@data', text: 'y' });
  assert.equal(m.getInbox(data).length, 2);
});

test('group routing: mention mode only wakes mentioned members; non-members cannot read', () => {
  const { m, human, agent } = setup();
  const alice = human('alice');
  const a1 = agent(alice, 'writer'), a2 = agent(alice, 'reviewer');
  const g = m.createGroup(alice, { title: 'PRD', members: ['@writer', '@reviewer'] });

  m.sendMessage(alice, { to: g.id, text: 'no mention' });
  assert.equal(m.getInbox(a1).length + m.getInbox(a2).length, 0);
  m.sendMessage(alice, { to: g.id, text: '@writer draft it' });
  assert.equal(m.getInbox(a1).length, 1);
  assert.equal(m.getInbox(a2).length, 0);
  m.sendMessage(alice, { to: g.id, text: '@all sync' });
  assert.equal(m.getInbox(a2).length, 1);

  const all = m.createGroup(alice, { title: 'broadcast', members: ['@writer', '@reviewer'], routing_mode: 'all' });
  m.sendMessage(a1, { to: all.id, text: 'fyi' });
  assert.equal(m.getInbox(a2).filter((x) => x.conversation_id === all.id).length, 1);

  const mallory = human('mallory');
  assert.throws(() => m.history(mallory, g.id), code('forbidden'));
  assert.throws(() => m.sendMessage(mallory, { to: g.id, text: 'x' }), code('forbidden'));
  // Owner oversight: alice can read a DM between her own agents.
  const dm = m.sendMessage(a1, { to: '@reviewer', text: 'psst' });
  assert.equal(m.history(alice, dm.conversation_id).length, 1);
});

test('ContextPackage: recipients only, revocable, expiring, versioned, size-capped', () => {
  const { m, human, agent } = setup({ maxContextBytes: 2000 });
  const alice = human('alice'), bob = human('bob');
  const gpt = agent(alice, 'chatgpt'), claude = agent(alice, 'claude'), other = agent(alice, 'other');
  const outsider = agent(bob, 'outsider');

  const { context, message } = m.shareContext(gpt, {
    to: '@claude', task_goal: 'Draft PRD', confirmed_findings: ['f1'],
    sources: [{ title: 's', url: 'https://example.org' }],
    artifacts: [{ title: 'research.md', mime_type: 'text/markdown', content: '# Research' }],
  });
  assert.equal(context.version, 1);
  assert.equal(message.kind, 'context');
  const inbox = m.getInbox(claude);
  assert.equal(inbox[0].context.context_id, context.context_id);
  assert.equal(m.getContext(claude, context.context_id).artifacts[0].content, '# Research');
  assert.equal(m.getContext(alice, context.context_id).task_goal, 'Draft PRD'); // owner oversight
  assert.throws(() => m.getContext(other, context.context_id), code('forbidden'));
  assert.throws(() => m.getContext(outsider, context.context_id), code('forbidden'));
  assert.ok(m.listAudit(alice).some((a) => a.action === 'context.read_denied' && a.actor === 'outsider'));

  const v2 = m.shareContext(gpt, { to: '@claude', task_goal: 'Draft PRD (updated)', previous_context_id: context.context_id });
  assert.equal(v2.context.version, 2);
  assert.equal(v2.context.root_id, context.context_id);

  m.revokeContext(gpt, context.context_id);
  assert.throws(() => m.getContext(claude, context.context_id), code('forbidden'));
  m.db.prepare('UPDATE contexts SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', v2.context.context_id);
  assert.throws(() => m.getContext(claude, v2.context.context_id), code('forbidden'));

  assert.throws(() => m.shareContext(gpt, { to: '@claude', task_goal: 'big', summary: 'x'.repeat(3000) }), code('context_too_large'));
});

test('task handoff A→B→C keeps lineage; permissions enforced', () => {
  const { m, human, agent } = setup();
  const alice = human('alice');
  const gpt = agent(alice, 'chatgpt'), claude = agent(alice, 'claude'), codex = agent(alice, 'codex');
  const g = m.createGroup(alice, { title: 'handoff', members: ['@chatgpt', '@claude', '@codex'] });

  const { context } = m.shareContext(gpt, { to: g.id, task_goal: 'PRD', recipients: ['@claude'] });
  const { task } = m.delegateTask(gpt, { to: g.id, assignee: '@claude', title: 'Write PRD', context_id: context.context_id });
  assert.equal(task.status, 'pending');
  assert.ok(m.getInbox(claude).some((x) => x.task?.task_id === task.task_id));

  assert.throws(() => m.updateTask(codex, { task_id: task.task_id, status: 'completed' }), code('forbidden'));
  assert.throws(() => m.updateTask(gpt, { task_id: task.task_id, status: 'completed' }), code('forbidden'));
  m.updateTask(claude, { task_id: task.task_id, status: 'in_progress' });
  const done = m.updateTask(claude, { task_id: task.task_id, status: 'completed', result: '# PRD' });
  assert.equal(done.task.result, '# PRD');
  assert.ok(m.getInbox(gpt).some((x) => x.task?.status === 'completed'));
  assert.throws(() => m.updateTask(claude, { task_id: task.task_id, status: 'failed' }), code('invalid'));

  // Claude cannot widen access to ChatGPT's package; ChatGPT (creator) can.
  assert.throws(() => m.delegateTask(claude, { to: g.id, assignee: '@codex', title: 'Review', context_id: context.context_id }), code('forbidden'));
  const review = m.delegateTask(gpt, { to: g.id, assignee: '@codex', title: 'Review', context_id: context.context_id, parent_task_id: task.task_id });
  assert.equal(review.task.parent_task_id, task.task_id);
  assert.equal(m.getContext(codex, context.context_id).task_goal, 'PRD');
});

test('loop guard trips on runaway agent ping-pong and resets on a human turn', () => {
  const { m, human, agent } = setup({ maxAgentTurns: 4 });
  const alice = human('alice');
  const a = agent(alice, 'ping'), b = agent(alice, 'pong');
  const g = m.createGroup(alice, { title: 'loop', members: ['@ping', '@pong'] });
  for (let i = 0; i < 4; i++) m.sendMessage(i % 2 ? b : a, { to: g.id, text: `@${i % 2 ? 'ping' : 'pong'} ${i}` });
  assert.throws(() => m.sendMessage(a, { to: g.id, text: '@pong again' }), code('loop_guard'));
  m.sendMessage(alice, { to: g.id, text: 'carry on' });
  m.sendMessage(a, { to: g.id, text: '@pong ok' });
});

test('rate limit', () => {
  const { m, human } = setup({ ratePerMinute: 2 });
  const alice = human('alice');
  human('bob');
  const g = m.createGroup(alice, { title: 'x' });
  m.sendMessage(alice, { to: g.id, text: '1' });
  m.sendMessage(alice, { to: g.id, text: '2' });
  assert.throws(() => m.sendMessage(alice, { to: g.id, text: '3' }), code('rate_limited'));
});

test('HTTP: REST + MCP end to end, webhook push is signed and acks', async (t) => {
  const { server, messenger } = createApp({ limits: { webhookRetryDelaysMs: [0] } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const hooks = [];
  const hookServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    hooks.push({ headers: req.headers, body });
    res.writeHead(200).end();
  });
  await new Promise((r) => hookServer.listen(0, r));
  t.after(() => { server.close(); hookServer.close(); server.closeAllConnections(); });

  const api = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  let rpcId = 0;
  const rpc = async (url, method, params, headers = {}) => {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    return (await res.json());
  };
  const call = async (url, name, args, headers) => {
    const r = await rpc(url, 'tools/call', { name, arguments: args }, headers);
    return { data: JSON.parse(r.result.content[0].text), isError: !!r.result.isError };
  };

  const alice = (await api('POST', '/api/register', null, { handle: 'alice' })).json;
  assert.equal((await api('GET', '/api/me')).status, 401);
  const gpt = (await api('POST', '/api/agents', alice.token, { handle: 'chatgpt', runtime: 'chatgpt' })).json;
  const claude = (await api('POST', '/api/agents', alice.token, { handle: 'claude', runtime: 'claude-code' })).json;
  const bot = (await api('POST', '/api/agents', alice.token, {
    handle: 'bot', webhook_url: `http://localhost:${hookServer.address().port}/hook`,
  })).json;

  // ChatGPT-style: token in the URL path. Claude Code-style: Authorization header.
  const gptUrl = `${base}/mcp/${gpt.token}`;
  const claudeHeaders = { authorization: `Bearer ${claude.token}` };
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  const init = await rpc(gptUrl, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /@chatgpt/);
  const note = await fetch(gptUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const tools = await rpc(gptUrl, 'tools/list', {});
  assert.ok(tools.result.tools.some((x) => x.name === 'share_context'));

  const shared = await call(gptUrl, 'share_context', {
    to: '@claude', task_goal: 'Write PRD', artifacts: [{ title: 'r.md', mime_type: 'text/markdown', content: '# R' }],
  });
  assert.equal(shared.isError, false);
  const inbox = await call(`${base}/mcp`, 'get_inbox', {}, claudeHeaders);
  assert.equal(inbox.data.count, 1);
  const ctx = await call(`${base}/mcp`, 'get_context', { context_id: inbox.data.messages[0].context.context_id }, claudeHeaders);
  assert.equal(ctx.data.artifacts[0].content, '# R');
  await call(`${base}/mcp`, 'send_message', { to: '@chatgpt', text: 'PRD done' }, claudeHeaders);
  await call(`${base}/mcp`, 'ack_messages', { message_ids: [inbox.data.messages[0].id] }, claudeHeaders);
  const back = await call(gptUrl, 'get_inbox', {});
  assert.equal(back.data.messages[0].text, 'PRD done');
  await call(gptUrl, 'ack_messages', { message_ids: [back.data.messages[0].id] });
  const idle = await call(gptUrl, 'get_inbox', {});
  assert.equal(idle.data.open_tasks_you_delegated, 0);
  assert.match(idle.data.notice, /end it now without notifying the user/);
  const bad = await call(gptUrl, 'get_context', { context_id: 'ctx_nope' });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.error, 'not_found');

  // Long-poll resolves when a message arrives.
  const waiting = call(`${base}/mcp`, 'get_inbox', { wait_seconds: 5 }, claudeHeaders);
  setTimeout(() => messenger.sendMessage(messenger.resolve('@chatgpt'), { to: '@claude', text: 'wake up' }), 50);
  assert.equal((await waiting).data.messages[0].text, 'wake up');

  // Webhook delivery: signed, and 2xx acks the delivery.
  await call(gptUrl, 'send_message', { to: '@bot', text: 'ping bot' });
  for (let i = 0; i < 50 && !hooks.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(hooks.length, 1);
  const { headers, body } = hooks[0];
  const expected = createHmac('sha256', bot.webhook_secret).update(`${headers['x-am-timestamp']}.${body}`).digest('hex');
  assert.equal(headers['x-am-signature'], `sha256=${expected}`);
  assert.equal(JSON.parse(body).message.text, 'ping bot');
  for (let i = 0; i < 50 && (await api('GET', '/api/inbox', bot.token)).json.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await api('GET', '/api/inbox', bot.token)).json.length, 0);

  assert.equal((await fetch(`${base}/`)).status, 200);
});

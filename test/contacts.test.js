// Contact requests are not messages (the requester cannot reach the agent until the
// owner approves), so get_inbox reports them separately, once, with a link the user
// opens to decide. Agents can never decide them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

async function setup(t, opts = {}) {
  const { server, messenger: m } = createApp(opts);
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://localhost:${server.address().port}`;
  const human = (handle) => m.authenticate(m.registerHuman({ handle }).token);
  const agent = (owner, handle, headers = {}) => {
    const { token } = m.createAgent(owner, { handle });
    let id = 0;
    return async (name, args = {}) => {
      const res = await fetch(`${base}/mcp/${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      });
      const { result } = await res.json();
      return JSON.parse(result.content[0].text);
    };
  };
  return { m, base, human, agent };
}

test('get_inbox reports a new contact request once, with a link to approve it', async (t) => {
  const { m, human, agent } = await setup(t);
  const alex = human('alex'), chloe = human('chloe');
  // Behind a proxy, the forwarded host and protocol give the public address.
  const muse = agent(alex, 'muse', { 'x-forwarded-host': 'am.example.com', 'x-forwarded-proto': 'https' });
  const teamuse = agent(chloe, 'teamuse');

  await muse('sync_settings', { scheduled: true }); // turning sync on must not hide requests made before it
  assert.equal((await teamuse('send_message', { to: '@muse', text: 'hi' })).error, 'approval_required');

  const first = await muse('get_inbox');
  assert.equal(first.count, 0);
  assert.equal(first.pending_contact_requests.length, 1);
  assert.deepEqual(
    { requester: first.pending_contact_requests[0].requester, by: first.pending_contact_requests[0].requested_by, new: first.pending_contact_requests[0].new },
    { requester: 'chloe', by: 'teamuse', new: true },
  );
  assert.equal(first.approve_url, 'https://am.example.com/#contacts');
  assert.match(first.notice, /1 new contact request\(s\) need your user's approval/);
  assert.match(first.notice, /Do this even during a scheduled sync run/);
  assert.doesNotMatch(first.notice, /end it now without notifying/); // the user must hear about it

  // Next sync: still pending, but already reported, so the scheduled run stays quiet.
  const second = await muse('get_inbox');
  assert.equal(second.pending_contact_requests[0].new, false);
  assert.match(second.notice, /already reported/);
  assert.match(second.notice, /end it now without notifying the user/);

  // The list tool carries the same link; the agent still cannot decide.
  const listed = await muse('list_contact_requests');
  assert.equal(listed.approve_url, 'https://am.example.com/#contacts');
  assert.equal(listed.requests[0].direction, 'incoming');
  assert.equal(m.listConnections(alex)[0].status, 'pending');

  // Once the owner decides in the web UI, nothing is reported any more.
  m.decideConnection(alex, listed.requests[0].id, true);
  const after = await muse('get_inbox');
  assert.equal(after.pending_contact_requests, undefined);
  assert.equal(after.approve_url, undefined);

  // The requester's side never sees it as something to approve.
  assert.equal((await teamuse('get_inbox')).pending_contact_requests, undefined);
});

test('a configured public URL wins over request headers', async (t) => {
  const { human, agent } = await setup(t, { publicUrl: 'https://am.yunkeniled.top/' });
  const alex = human('alex'), chloe = human('chloe');
  const muse = agent(alex, 'muse', { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' });
  await agent(chloe, 'teamuse')('send_message', { to: '@muse', text: 'hi' });
  assert.equal((await muse('get_inbox')).approve_url, 'https://am.yunkeniled.top/#contacts');
});

test('each of the owner\'s agents reports a request once', async (t) => {
  const { human, agent } = await setup(t);
  const alex = human('alex'), chloe = human('chloe');
  const a = agent(alex, 'ag_a'), b = agent(alex, 'ag_b');
  await agent(chloe, 'ag_c')('send_message', { to: '@ag_a', text: 'hi' });
  assert.equal((await a('get_inbox')).pending_contact_requests[0].new, true);
  assert.equal((await a('get_inbox')).pending_contact_requests[0].new, false);
  assert.equal((await b('get_inbox')).pending_contact_requests[0].new, true); // b had not seen it
});

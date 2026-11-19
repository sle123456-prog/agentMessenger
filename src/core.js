// Domain logic for Agent Messenger: principals, contacts, conversations, reliable
// inbox, ContextPackages, tasks, policy and audit. Transport-agnostic — REST, MCP
// and the web UI all call into this class.
import { EventEmitter } from 'node:events';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { openDb } from './db.js';

export class AMError extends Error {
  constructor(code, message, status = 400, extra) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}
const err = (code, message, status, extra) => new AMError(code, message, status, extra);
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const HANDLE_RE = /^[a-z0-9_]{2,32}$/;
const TASK_STATUSES = ['pending', 'accepted', 'in_progress', 'needs_input', 'completed', 'failed', 'cancelled'];
const ASSIGNEE_STATUSES = ['accepted', 'in_progress', 'needs_input', 'completed', 'failed'];

const DEFAULT_LIMITS = {
  maxTextChars: 16000,
  maxContextBytes: 256 * 1024,
  ratePerMinute: 60, // messages per sender per minute
  maxAgentTurns: 20, // consecutive agent messages (no human in between) per window
  agentTurnWindowMs: 10 * 60 * 1000,
  webhookRetryDelaysMs: [0, 1000, 5000],
};

export class Messenger extends EventEmitter {
  constructor({ dbPath = ':memory:', limits = {}, inviteCode = null, syncMinutes = 5 } = {}) {
    super();
    this.setMaxListeners(0);
    this.db = openDb(dbPath);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.inviteCode = inviteCode;
    // Default interval for the inbox sync each client schedules for itself; 0 turns auto-sync off.
    this.syncMinutes = Math.min(1440, Math.max(0, Math.round(Number(syncMinutes)) || 0));
  }

  // ---------- helpers ----------
  _get(sql, ...p) { return this.db.prepare(sql).get(...p); }
  _all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  _run(sql, ...p) { return this.db.prepare(sql).run(...p); }
  _principal(id) { return this._get('SELECT * FROM principals WHERE id = ?', id); }
  _ownerId(p) { return p.kind === 'agent' ? p.owner_id : p.id; }
  /** True if actor is the principal, or the human who owns it. */
  _onSide(actor, principalId) {
    if (actor.id === principalId) return true;
    return actor.kind === 'human' && this._principal(principalId)?.owner_id === actor.id;
  }
  _scopeIds(actor) {
    if (actor.kind !== 'human') return [actor.id];
    return [actor.id, ...this._all('SELECT id FROM principals WHERE owner_id = ?', actor.id).map((r) => r.id)];
  }

  audit(actor, action, target, detail = {}, affectsOwner = null) {
    this._run(
      'INSERT INTO audit(ts, actor_id, owner_id, affects_owner, action, target, detail) VALUES (?,?,?,?,?,?,?)',
      now(), actor?.id ?? null, actor ? this._ownerId(actor) : null, affectsOwner, action, target ?? null,
      JSON.stringify(detail),
    );
  }

  listAudit(actor, { limit = 100 } = {}) {
    const owner = this._ownerId(actor);
    return this._all(
      `SELECT a.seq, a.ts, a.action, a.target, a.detail, p.handle AS actor
       FROM audit a LEFT JOIN principals p ON p.id = a.actor_id
       WHERE a.owner_id = ? OR a.affects_owner = ? ORDER BY a.seq DESC LIMIT ?`,
      owner, owner, Math.min(Number(limit) || 100, 500),
    ).map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
  }

  publicPrincipal(p) {
    if (!p) return null;
    const owner = p.owner_id ? this._principal(p.owner_id) : null;
    return {
      id: p.id, kind: p.kind, handle: p.handle, display_name: p.display_name,
      owner_handle: owner?.handle ?? null, runtime: p.runtime, description: p.description,
      has_webhook: !!p.webhook_url, last_seen_at: p.last_seen_at,
      sync: p.kind === 'agent' ? this.syncStatus(p) : undefined,
    };
  }

  // ---------- identity ----------
  _newPrincipal({ kind, handle, display_name, owner_id = null, runtime = null, description = null, webhook_url = null }) {
    handle = String(handle || '').replace(/^@/, '').toLowerCase();
    if (!HANDLE_RE.test(handle) || handle === 'all') {
      throw err('invalid_handle', 'handle must be 2-32 chars of a-z, 0-9, _');
    }
    if (this._get('SELECT 1 FROM principals WHERE handle = ?', handle)) {
      throw err('handle_taken', `@${handle} is already taken`, 409);
    }
    if (webhook_url) this._checkWebhookUrl(webhook_url);
    const token = `am_${randomBytes(24).toString('base64url')}`;
    const id = newId(kind === 'agent' ? 'agt' : 'usr');
    const secret = kind === 'agent' ? randomBytes(24).toString('base64url') : null;
    this._run(
      `INSERT INTO principals(id, kind, handle, display_name, owner_id, token_hash, runtime, description,
        webhook_url, webhook_secret, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, kind, handle, String(display_name || handle).slice(0, 80), owner_id, sha256(token), runtime,
      description, webhook_url, secret, now(),
    );
    return { principal: this._principal(id), token };
  }

  _checkWebhookUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw err('invalid_webhook', 'webhook_url is not a valid URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw err('invalid_webhook', 'webhook_url must be http(s)');
  }

  registerHuman({ handle, display_name, invite_code } = {}) {
    if (this.inviteCode && invite_code !== this.inviteCode) throw err('forbidden', 'invalid invite code', 403);
    const { principal, token } = this._newPrincipal({ kind: 'human', handle, display_name });
    this.audit(principal, 'principal.registered', principal.id);
    return { principal: this.publicPrincipal(principal), token };
  }

  createAgent(actor, { handle, display_name, runtime, description, webhook_url } = {}) {
    if (actor.kind !== 'human') throw err('forbidden', 'only humans can create agents', 403);
    const { principal, token } = this._newPrincipal({
      kind: 'agent', handle, display_name, owner_id: actor.id,
      runtime: runtime || null, description: description || null, webhook_url: webhook_url || null,
    });
    this.audit(actor, 'agent.created', principal.id, { handle: principal.handle });
    return { agent: this.publicPrincipal(principal), token, webhook_secret: principal.webhook_secret };
  }

  _ownedAgent(actor, agentId) {
    const a = this._principal(agentId);
    if (!a || a.kind !== 'agent' || a.owner_id !== actor.id) throw err('not_found', 'agent not found', 404);
    return a;
  }

  updateAgent(actor, agentId, patch = {}) {
    const a = this._ownedAgent(actor, agentId);
    if (patch.webhook_url) this._checkWebhookUrl(patch.webhook_url);
    this._run(
      'UPDATE principals SET display_name = ?, description = ?, runtime = ?, webhook_url = ? WHERE id = ?',
      patch.display_name ?? a.display_name, patch.description ?? a.description, patch.runtime ?? a.runtime,
      patch.webhook_url === undefined ? a.webhook_url : patch.webhook_url || null, a.id,
    );
    this.audit(actor, 'agent.updated', a.id, { fields: Object.keys(patch) });
    const updated = this._principal(a.id);
    return { agent: this.publicPrincipal(updated), webhook_secret: updated.webhook_secret };
  }

  rotateAgentToken(actor, agentId) {
    const a = this._ownedAgent(actor, agentId);
    const token = `am_${randomBytes(24).toString('base64url')}`;
    this._run('UPDATE principals SET token_hash = ? WHERE id = ?', sha256(token), a.id);
    this.audit(actor, 'agent.token_rotated', a.id);
    return { agent: this.publicPrincipal(a), token };
  }

  listAgents(actor) {
    return this._all('SELECT * FROM principals WHERE owner_id = ? ORDER BY created_at', this._ownerId(actor))
      .map((p) => this.publicPrincipal(p));
  }

  authenticate(token) {
    if (!token || typeof token !== 'string') return null;
    const p = this._get('SELECT * FROM principals WHERE token_hash = ?', sha256(token));
    if (p) this._run('UPDATE principals SET last_seen_at = ? WHERE id = ?', now(), p.id);
    return p ?? null;
  }

  resolve(ref) {
    const s = String(ref || '').trim();
    const p = /^(usr|agt)_/.test(s)
      ? this._principal(s)
      : this._get('SELECT * FROM principals WHERE handle = ?', s.replace(/^@/, '').toLowerCase());
    if (!p) throw err('not_found', `no such principal: ${s}`, 404);
    return p;
  }

  directory({ q = '' } = {}) {
    return this._all(
      'SELECT * FROM principals WHERE handle LIKE ? OR display_name LIKE ? ORDER BY handle LIMIT 100',
      `%${q}%`, `%${q}%`,
    ).map((p) => this.publicPrincipal(p));
  }

  // ---------- contacts / communication policy ----------
  _connection(oa, ob) {
    return this._get(
      `SELECT * FROM connections WHERE (requester_owner = ? AND target_owner = ?)
        OR (requester_owner = ? AND target_owner = ?)`, oa, ob, ob, oa,
    );
  }

  canContact(a, b) {
    const oa = this._ownerId(a), ob = this._ownerId(b);
    return oa === ob || this._connection(oa, ob)?.status === 'accepted';
  }

  /** Cross-owner contact needs the other owner's approval. Same-owner principals talk freely. */
  requireContact(actor, target) {
    const oa = this._ownerId(actor), ob = this._ownerId(target);
    if (oa === ob) return;
    let c = this._connection(oa, ob);
    if (c?.status === 'accepted') return;
    // A human reaching out to someone who already asked them counts as accepting.
    if (c?.status === 'pending' && c.target_owner === oa && actor.kind === 'human') {
      this.decideConnection(actor, c.id, true);
      return;
    }
    if (c?.status === 'rejected') {
      this.audit(actor, 'contact.denied', target.id, { reason: 'rejected' }, ob);
      throw err('contact_rejected', `contact with @${target.handle}'s owner was declined`, 403);
    }
    if (!c) {
      const id = newId('con');
      this._run(
        'INSERT INTO connections(id, requester_owner, target_owner, status, requested_by, created_at) VALUES (?,?,?,?,?,?)',
        id, oa, ob, 'pending', actor.id, now(),
      );
      c = { id };
      this.audit(actor, 'contact.requested', target.id, { connection_id: id }, ob);
      this.emit('activity', { audience: new Set([oa, ob]) });
    }
    throw err(
      'approval_required',
      `@${target.handle} belongs to another owner (@${this._principal(ob).handle}). A contact request is pending their approval; retry after it is accepted.`,
      403, { connection_id: c.id },
    );
  }

  requestContact(actor, ref) {
    const target = this.resolve(ref);
    try { this.requireContact(actor, target); } catch (e) {
      if (e.code !== 'approval_required') throw e;
      return { status: 'pending', ...e.extra };
    }
    return { status: 'accepted' };
  }

  listConnections(actor) {
    const me = this._ownerId(actor);
    return this._all(
      'SELECT * FROM connections WHERE requester_owner = ? OR target_owner = ? ORDER BY created_at DESC', me, me,
    ).map((c) => ({
      id: c.id, status: c.status, created_at: c.created_at,
      direction: c.target_owner === me ? 'incoming' : 'outgoing',
      requester: this._principal(c.requester_owner).handle,
      target: this._principal(c.target_owner).handle,
      requested_by: this._principal(c.requested_by).handle,
    }));
  }

  decideConnection(actor, id, accept) {
    const c = this._get('SELECT * FROM connections WHERE id = ?', id);
    // Only the target owner, as a human, can decide. Agents cannot approve
    // on the owner's behalf: approval is the trust boundary between owners,
    // and agents read untrusted content.
    if (!c || actor.kind !== 'human' || c.target_owner !== actor.id) {
      throw err('not_found', 'no such incoming contact request', 404);
    }
    const status = accept ? 'accepted' : 'rejected';
    this._run('UPDATE connections SET status = ?, decided_at = ? WHERE id = ?', status, now(), id);
    this.audit(actor, `contact.${status}`, id, {}, c.requester_owner);
    this.emit('activity', { audience: new Set([c.requester_owner, c.target_owner]) });
    return { id, status };
  }

  // ---------- conversations ----------
  _conv(id) {
    const c = this._get('SELECT * FROM conversations WHERE id = ?', id);
    if (!c) throw err('not_found', `no such conversation: ${id}`, 404);
    return c;
  }
  _memberRows(convId) {
    return this._all(
      `SELECT p.* FROM members m JOIN principals p ON p.id = m.principal_id
       WHERE m.conversation_id = ? ORDER BY m.joined_at`, convId,
    );
  }
  _isMember(convId, pid) {
    return !!this._get('SELECT 1 FROM members WHERE conversation_id = ? AND principal_id = ?', convId, pid);
  }
  _addMember(convId, pid, role = 'member') {
    this._run('INSERT OR IGNORE INTO members(conversation_id, principal_id, role, joined_at) VALUES (?,?,?,?)',
      convId, pid, role, now());
  }
  /** Members can read; a human can also read conversations their agents are in (oversight). */
  _canRead(actor, convId) {
    const ids = this._scopeIds(actor);
    return !!this._get(
      `SELECT 1 FROM members WHERE conversation_id = ? AND principal_id IN (${ids.map(() => '?').join(',')})`,
      convId, ...ids,
    );
  }
  _requireRead(actor, convId) {
    const c = this._conv(convId);
    if (!this._canRead(actor, convId)) {
      this.audit(actor, 'conversation.read_denied', convId);
      throw err('forbidden', 'you are not a member of this conversation', 403);
    }
    return c;
  }
  _audience(convId) {
    return new Set(this._memberRows(convId).map((p) => this._ownerId(p)));
  }

  conversationView(c) {
    return {
      id: c.id, kind: c.kind, title: c.title, routing_mode: c.routing_mode, created_at: c.created_at,
      members: this._memberRows(c.id).map((p) => this.publicPrincipal(p)),
    };
  }

  _dm(a, b) {
    const key = [a.id, b.id].sort().join(':');
    let c = this._get('SELECT * FROM conversations WHERE dm_key = ?', key);
    if (!c) {
      const id = newId('conv');
      this._run('INSERT INTO conversations(id, kind, dm_key, created_by, created_at) VALUES (?,?,?,?,?)',
        id, 'dm', key, a.id, now());
      this._addMember(id, a.id);
      this._addMember(id, b.id);
      this.audit(a, 'conversation.dm_created', id, { with: b.handle }, this._ownerId(b));
      c = this._conv(id);
    }
    return c;
  }

  createGroup(actor, { title, members = [], routing_mode = 'mention' } = {}) {
    if (!['mention', 'all'].includes(routing_mode)) throw err('invalid', 'routing_mode must be mention or all');
    const invitees = [...new Set(members)].map((m) => this.resolve(m)).filter((p) => p.id !== actor.id);
    for (const p of invitees) this.requireContact(actor, p);
    const id = newId('conv');
    this._run('INSERT INTO conversations(id, kind, title, routing_mode, created_by, created_at) VALUES (?,?,?,?,?,?)',
      id, 'group', String(title || 'Untitled group').slice(0, 120), routing_mode, actor.id, now());
    this._addMember(id, actor.id, 'owner');
    for (const p of invitees) {
      this._addMember(id, p.id);
      this.audit(actor, 'conversation.member_added', id, { member: p.handle }, this._ownerId(p));
    }
    this.audit(actor, 'conversation.group_created', id, { title });
    this.emit('activity', { audience: this._audience(id) });
    return this.conversationView(this._conv(id));
  }

  inviteMember(actor, convId, ref) {
    const c = this._conv(convId);
    if (c.kind !== 'group') throw err('invalid', 'cannot invite into a DM');
    if (!this._isMember(convId, actor.id)) throw err('forbidden', 'only members can invite', 403);
    const p = this.resolve(ref);
    this.requireContact(actor, p);
    this._addMember(convId, p.id);
    this.audit(actor, 'conversation.member_added', convId, { member: p.handle }, this._ownerId(p));
    this.emit('activity', { audience: this._audience(convId) });
    return this.conversationView(c);
  }

  listConversations(actor) {
    const ids = this._scopeIds(actor);
    const rows = this._all(
      `SELECT DISTINCT c.* FROM conversations c JOIN members m ON m.conversation_id = c.id
       WHERE m.principal_id IN (${ids.map(() => '?').join(',')})`, ...ids,
    );
    return rows.map((c) => {
      const last = this._get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1', c.id);
      const unread = this._get(
        `SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.recipient_id = ? AND d.status != 'acked' AND m.conversation_id = ?`, actor.id, c.id,
      ).n;
      return { ...this.conversationView(c), unread, last_message: last ? this.messageView(last) : null };
    }).sort((a, b) => (b.last_message?.seq ?? 0) - (a.last_message?.seq ?? 0));
  }

  /** `to` is a conversation id, or a handle/principal id (opens a DM). */
  _resolveTarget(actor, to) {
    if (!to) throw err('invalid', '`to` is required: a conversation id or an @handle');
    if (String(to).startsWith('conv_')) {
      const c = this._conv(to);
      if (!this._isMember(c.id, actor.id)) {
        // A human may step into a group their own agent is in.
        if (c.kind === 'group' && actor.kind === 'human' && this._canRead(actor, c.id)) {
          this._addMember(c.id, actor.id);
          this.audit(actor, 'conversation.owner_joined', c.id);
        } else {
          this.audit(actor, 'message.denied', c.id, { reason: 'not_member' });
          throw err('forbidden', 'you are not a member of this conversation', 403);
        }
      }
      return c;
    }
    const target = this.resolve(to);
    if (target.id === actor.id) throw err('invalid', 'cannot message yourself');
    this.requireContact(actor, target);
    return this._dm(actor, target);
  }

  // ---------- messages ----------
  messageView(m) {
    const s = this._principal(m.sender_id);
    const v = {
      id: m.id, seq: m.seq, conversation_id: m.conversation_id, kind: m.kind,
      sender: { id: s.id, handle: s.handle, kind: s.kind, display_name: s.display_name },
      text: m.text, reply_to: m.reply_to, created_at: m.created_at,
    };
    if (m.context_id) {
      const c = this._get('SELECT * FROM contexts WHERE id = ?', m.context_id);
      v.context = {
        context_id: c.id, version: c.version, task_goal: JSON.parse(c.payload).task_goal,
        expires_at: c.expires_at, revoked: !!c.revoked_at,
      };
    }
    if (m.task_id) v.task = this.taskView(this._get('SELECT * FROM tasks WHERE id = ?', m.task_id));
    return v;
  }

  _guards(actor, conv) {
    const L = this.limits;
    const since = new Date(Date.now() - 60_000).toISOString();
    const sent = this._get('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND created_at > ?', actor.id, since).n;
    if (sent >= L.ratePerMinute) {
      this.audit(actor, 'message.rate_limited', conv.id);
      throw err('rate_limited', `rate limit: max ${L.ratePerMinute} messages per minute`, 429);
    }
    if (actor.kind !== 'agent') return;
    // Circuit breaker for agent<->agent loops: too many agent messages in a row with no human turn.
    const windowStart = new Date(Date.now() - L.agentTurnWindowMs).toISOString();
    const turns = this._get(
      `SELECT COUNT(*) AS n FROM messages m WHERE m.conversation_id = ? AND m.created_at > ? AND m.seq >
        COALESCE((SELECT MAX(m2.seq) FROM messages m2 JOIN principals p ON p.id = m2.sender_id
                  WHERE m2.conversation_id = ? AND p.kind = 'human'), 0)`,
      conv.id, windowStart, conv.id,
    ).n;
    if (turns >= L.maxAgentTurns) {
      this.audit(actor, 'message.loop_guard', conv.id, { turns });
      this.emit('activity', { audience: this._audience(conv.id) });
      throw err(
        'loop_guard',
        `circuit breaker: ${turns} consecutive agent messages without a human turn. Stop and wait for a human to continue.`,
        429,
      );
    }
  }

  _post(actor, conv, { text, kind = 'text', reply_to = null, context_id = null, task_id = null,
    idempotency_key = null, notify = [], bypassGuards = false }) {
    text = String(text ?? '').trim();
    if (!text) throw err('invalid', 'message text is empty');
    if (text.length > this.limits.maxTextChars) {
      throw err('too_large', `message exceeds ${this.limits.maxTextChars} chars; send a shorter message or use share_context`, 413);
    }
    if (idempotency_key) {
      const dup = this._get('SELECT * FROM messages WHERE sender_id = ? AND idempotency_key = ?', actor.id, String(idempotency_key));
      if (dup) return { ...this.messageView(dup), duplicate: true };
    }
    if (!bypassGuards) this._guards(actor, conv);

    let replied = null;
    if (reply_to) {
      replied = this._get('SELECT * FROM messages WHERE id = ? AND conversation_id = ?', reply_to, conv.id);
      if (!replied) throw err('invalid', 'reply_to must be a message in the same conversation');
    }
    const id = newId('msg');
    this._run(
      `INSERT INTO messages(id, conversation_id, sender_id, kind, text, reply_to, context_id, task_id, idempotency_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, conv.id, actor.id, kind, text, reply_to, context_id, task_id,
      idempotency_key ? String(idempotency_key) : null, now(),
    );

    // Routing: who gets this in their inbox.
    const members = this._memberRows(conv.id).filter((p) => p.id !== actor.id);
    const recipients = new Map(); // id -> reason
    const mentioned = new Set([...text.matchAll(/@([a-zA-Z0-9_]+)/g)].map((m) => m[1].toLowerCase()));
    for (const p of members) {
      if (conv.kind === 'dm') recipients.set(p.id, 'dm');
      else if (mentioned.has(p.handle) || mentioned.has('all')) recipients.set(p.id, 'mention');
      else if (notify.includes(p.id)) recipients.set(p.id, 'direct');
      else if (replied?.sender_id === p.id) recipients.set(p.id, 'reply');
      else if (conv.routing_mode === 'all') recipients.set(p.id, 'broadcast');
    }
    for (const [rid, reason] of recipients) {
      this._run('INSERT INTO deliveries(message_id, recipient_id, reason) VALUES (?,?,?)', id, rid, reason);
    }
    const view = this.messageView(this._get('SELECT * FROM messages WHERE id = ?', id));
    this.audit(actor, 'message.sent', id, { conversation_id: conv.id, kind, recipients: recipients.size });
    this.emit('activity', { audience: this._audience(conv.id), conversation_id: conv.id });
    for (const [rid, reason] of recipients) {
      this.emit(`inbox:${rid}`);
      const r = this._principal(rid);
      if (r.webhook_url) this._webhook(r, view, reason, conv);
    }
    return { ...view, delivered_to: [...recipients.keys()].map((rid) => this._principal(rid).handle) };
  }

  sendMessage(actor, { to, text, reply_to, idempotency_key } = {}) {
    const conv = this._resolveTarget(actor, to);
    return this._post(actor, conv, { text, reply_to: reply_to || null, idempotency_key });
  }

  history(actor, convId, { limit = 50, before_seq } = {}) {
    this._requireRead(actor, convId);
    limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = this._all(
      'SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
      convId, Number(before_seq) || Number.MAX_SAFE_INTEGER, limit,
    ).reverse();
    return rows.map((m) => this.messageView(m));
  }

  // ---------- automatic sync ----------
  // Nothing can wake a chat client from outside, so each client schedules its own
  // recurring inbox check. The server keeps the desired interval and whether the
  // client reported the schedule as set up, and notices when checks stop arriving.
  //   pending      no schedule yet (or it lapsed): the client is asked to create one
  //   active       client confirmed the schedule and checks keep arriving
  //   stopped      the user turned sync off
  //   unsupported  the client said it cannot schedule recurring tasks
  syncStatus(p) {
    const interval = p.sync_minutes ?? this.syncMinutes;
    let state = interval ? p.sync_state : 'stopped';
    if (state === 'active') {
      const grace = Math.max(interval * 3, 15) * 60_000;
      if (!p.last_inbox_at || Date.now() - Date.parse(p.last_inbox_at) > grace) state = 'pending';
    }
    return { state, interval_minutes: interval, last_sync_at: p.last_inbox_at ?? null };
  }

  setSync(actor, { interval_minutes, enabled, scheduled } = {}) {
    let p = this._principal(actor.id);
    let { sync_minutes: minutes, sync_state: state } = p;
    if (interval_minutes !== undefined && interval_minutes !== null) {
      const n = Math.round(Number(interval_minutes));
      if (!Number.isFinite(n) || n < 1 || n > 1440) throw err('invalid', 'interval_minutes must be between 1 and 1440');
      if (n !== (minutes ?? this.syncMinutes)) state = 'pending'; // the client must reschedule
      minutes = n;
      if (state === 'stopped') state = 'pending';
    }
    if (enabled === false) state = 'stopped';
    if (enabled === true && ['stopped', 'unsupported'].includes(state)) {
      state = 'pending';
      if (minutes === 0) minutes = null;
    }
    if (scheduled === true && state !== 'stopped') state = 'active';
    if (scheduled === false) state = 'unsupported';
    this._run('UPDATE principals SET sync_minutes = ?, sync_state = ?, last_inbox_at = CASE WHEN ? THEN ? ELSE last_inbox_at END WHERE id = ?',
      minutes ?? null, state, scheduled === true ? 1 : 0, now(), p.id);
    this.audit(actor, 'sync.updated', p.id, { state, interval_minutes: minutes ?? this.syncMinutes });
    this.emit('activity', { audience: new Set([this._ownerId(p)]) });
    p = this._principal(p.id);
    return this.syncStatus(p);
  }

  // ---------- reliable inbox: at-least-once until acked ----------
  getInbox(actor, { limit = 20 } = {}) {
    this._run('UPDATE principals SET last_inbox_at = ? WHERE id = ?', now(), actor.id);
    limit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = this._all(
      `SELECT m.*, d.reason, d.attempts FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.recipient_id = ? AND d.status != 'acked' ORDER BY m.seq LIMIT ?`, actor.id, limit,
    );
    for (const r of rows) {
      this._run(`UPDATE deliveries SET status = 'delivered', attempts = attempts + 1 WHERE message_id = ? AND recipient_id = ?`,
        r.id, actor.id);
    }
    return rows.map((r) => {
      const c = this._conv(r.conversation_id);
      return {
        ...this.messageView(r), reason: r.reason, redelivery: r.attempts > 0,
        conversation: { id: c.id, kind: c.kind, title: c.title },
      };
    });
  }

  /** Long-poll variant: resolves as soon as something arrives, or after wait_seconds. */
  async waitInbox(actor, { limit, wait_seconds = 0 } = {}) {
    let items = this.getInbox(actor, { limit });
    const wait = Math.min(Math.max(Number(wait_seconds) || 0, 0), 50);
    if (items.length || !wait) return items;
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.off(`inbox:${actor.id}`, done); resolve(); };
      const timer = setTimeout(done, wait * 1000);
      this.once(`inbox:${actor.id}`, done);
    });
    return this.getInbox(actor, { limit });
  }

  ack(actor, { message_ids = [], conversation_id } = {}) {
    let n = 0;
    const t = now();
    if (conversation_id) {
      n += this._run(
        `UPDATE deliveries SET status = 'acked', acked_at = ? WHERE recipient_id = ? AND status != 'acked'
         AND message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`, t, actor.id, conversation_id,
      ).changes;
    }
    for (const id of message_ids) {
      n += this._run(
        `UPDATE deliveries SET status = 'acked', acked_at = ? WHERE recipient_id = ? AND message_id = ? AND status != 'acked'`,
        t, actor.id, String(id),
      ).changes;
    }
    if (n) this.emit('activity', { audience: new Set([this._ownerId(actor)]) });
    return { acked: Number(n) };
  }

  // ---------- webhook push (for developer-run agents) ----------
  async _webhook(recipient, message, reason, conv) {
    const body = JSON.stringify({
      type: 'message.created', recipient: { id: recipient.id, handle: recipient.handle }, reason, message,
      conversation: { id: conv.id, kind: conv.kind, title: conv.title },
    });
    for (const delay of this.limits.webhookRetryDelaysMs) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', recipient.webhook_secret).update(`${ts}.${body}`).digest('hex');
      try {
        const res = await fetch(recipient.webhook_url, {
          method: 'POST', body, signal: AbortSignal.timeout(10_000),
          headers: {
            'content-type': 'application/json', 'x-am-timestamp': ts, 'x-am-signature': `sha256=${sig}`,
            'x-am-delivery': message.id,
          },
        });
        if (res.ok) { // 2xx is the ACK
          this.ack(recipient, { message_ids: [message.id] });
          this.audit(recipient, 'webhook.delivered', message.id);
          return;
        }
      } catch { /* retry */ }
    }
    // Message stays in the inbox for polling; nothing is lost.
    this.audit(recipient, 'webhook.failed', message.id, { url: recipient.webhook_url });
  }

  // ---------- ContextPackage ----------
  contextView(c) {
    const p = JSON.parse(c.payload);
    return {
      context_id: c.id, root_id: c.root_id, version: c.version,
      origin: { agent: this._principal(c.creator_id).handle, conversation_ref: p.conversation_ref ?? null },
      task_goal: p.task_goal, summary: p.summary, confirmed_findings: p.confirmed_findings,
      constraints: p.constraints, open_questions: p.open_questions, sources: p.sources, artifacts: p.artifacts,
      access: {
        recipients: JSON.parse(c.recipients).map((id) => this._principal(id).handle),
        expires_at: c.expires_at, revoked_at: c.revoked_at,
      },
      created_at: c.created_at,
    };
  }

  shareContext(actor, a = {}) {
    if (!a.task_goal) throw err('invalid', 'task_goal is required');
    const conv = this._resolveTarget(actor, a.to);
    const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    const payload = {
      task_goal: String(a.task_goal), summary: a.summary ? String(a.summary) : null,
      confirmed_findings: list(a.confirmed_findings), constraints: list(a.constraints),
      open_questions: list(a.open_questions), sources: list(a.sources), artifacts: list(a.artifacts),
      conversation_ref: a.conversation_ref ?? null,
    };
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > this.limits.maxContextBytes) {
      throw err('context_too_large',
        `context package exceeds ${this.limits.maxContextBytes} bytes; compress it (summarize findings, link instead of inlining artifacts)`, 413);
    }
    const members = this._memberRows(conv.id);
    const recipients = a.recipients?.length
      ? list(a.recipients).map((r) => this.resolve(r))
      : members.filter((p) => p.id !== actor.id);
    for (const r of recipients) {
      if (!members.some((m) => m.id === r.id)) throw err('invalid', `@${r.handle} is not a member of the target conversation`);
    }
    let root = null, version = 1;
    if (a.previous_context_id) {
      const prev = this._get('SELECT * FROM contexts WHERE id = ?', a.previous_context_id);
      if (!prev || !this._onSide(actor, prev.creator_id)) throw err('forbidden', 'previous_context_id must be a package you created', 403);
      root = prev.root_id;
      version = this._get('SELECT MAX(version) AS v FROM contexts WHERE root_id = ?', root).v + 1;
    }
    if (a.idempotency_key) {
      const dup = this._get('SELECT * FROM messages WHERE sender_id = ? AND idempotency_key = ?', actor.id, String(a.idempotency_key));
      if (dup?.context_id) {
        return { context: this.contextView(this._get('SELECT * FROM contexts WHERE id = ?', dup.context_id)),
          message: { ...this.messageView(dup), duplicate: true } };
      }
    }
    const hours = Math.min(Math.max(Number(a.expires_in_hours) || 168, 1), 24 * 90);
    const id = newId('ctx');
    this._run(
      `INSERT INTO contexts(id, root_id, version, creator_id, conversation_id, payload, recipients, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id, root ?? id, version, actor.id, conv.id, json, JSON.stringify(recipients.map((r) => r.id)),
      new Date(Date.now() + hours * 3600_000).toISOString(), now(),
    );
    for (const r of recipients) {
      this.audit(actor, 'context.shared', id, { with: r.handle, version }, this._ownerId(r));
    }
    const message = this._post(actor, conv, {
      kind: 'context', context_id: id, idempotency_key: a.idempotency_key, notify: recipients.map((r) => r.id),
      text: `[ContextPackage ${id} v${version}] ${payload.task_goal}${a.note ? `\n${a.note}` : ''}\nCall get_context("${id}") to read it.`,
    });
    return { context: this.contextView(this._get('SELECT * FROM contexts WHERE id = ?', id)), message };
  }

  getContext(actor, id) {
    const c = this._get('SELECT * FROM contexts WHERE id = ?', id);
    if (!c) throw err('not_found', 'no such context package', 404);
    const creatorOwner = this._ownerId(this._principal(c.creator_id));
    let deny = null;
    if (!this._onSide(actor, c.creator_id)) {
      if (!JSON.parse(c.recipients).some((r) => this._onSide(actor, r))) deny = 'not_a_recipient';
      else if (c.revoked_at) deny = 'revoked';
      else if (c.expires_at && c.expires_at < now()) deny = 'expired';
    }
    if (deny) {
      this.audit(actor, 'context.read_denied', id, { reason: deny }, creatorOwner);
      throw err('forbidden', `access to this context package denied: ${deny}`, 403);
    }
    this.audit(actor, 'context.read', id, {}, creatorOwner);
    return this.contextView(c);
  }

  revokeContext(actor, id) {
    const c = this._get('SELECT * FROM contexts WHERE id = ?', id);
    if (!c || !this._onSide(actor, c.creator_id)) throw err('not_found', 'no such context package of yours', 404);
    this._run('UPDATE contexts SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now(), id);
    this.audit(actor, 'context.revoked', id);
    if (c.conversation_id) this.emit('activity', { audience: this._audience(c.conversation_id), conversation_id: c.conversation_id });
    return this.contextView(this._get('SELECT * FROM contexts WHERE id = ?', id));
  }

  // ---------- tasks ----------
  taskView(t) {
    return {
      task_id: t.id, conversation_id: t.conversation_id, title: t.title, instructions: t.instructions,
      status: t.status, creator: this._principal(t.creator_id).handle, assignee: this._principal(t.assignee_id).handle,
      context_id: t.context_id, parent_task_id: t.parent_task_id, result: t.result,
      created_at: t.created_at, updated_at: t.updated_at,
    };
  }

  delegateTask(actor, a = {}) {
    if (!a.title) throw err('invalid', 'title is required');
    const conv = this._resolveTarget(actor, a.to);
    const members = this._memberRows(conv.id);
    let assignee;
    if (a.assignee) assignee = this.resolve(a.assignee);
    else if (conv.kind === 'dm') assignee = members.find((p) => p.id !== actor.id);
    else throw err('invalid', 'assignee is required in a group');
    if (!members.some((m) => m.id === assignee.id)) throw err('invalid', `@${assignee.handle} is not a member of the conversation`);
    if (a.context_id) {
      const c = this._get('SELECT * FROM contexts WHERE id = ?', a.context_id);
      if (!c) throw err('not_found', 'no such context package', 404);
      const rec = JSON.parse(c.recipients);
      if (!rec.includes(assignee.id) && assignee.id !== c.creator_id) {
        // Only the package's creator side can widen access; others must ask its owner.
        if (!this._onSide(actor, c.creator_id)) {
          throw err('forbidden', `@${assignee.handle} has no access to ${c.id}; ask its creator to share it with them`, 403);
        }
        this._run('UPDATE contexts SET recipients = ? WHERE id = ?', JSON.stringify([...rec, assignee.id]), c.id);
        this.audit(actor, 'context.shared', c.id, { with: assignee.handle, via: 'task' }, this._ownerId(assignee));
      }
    }
    if (a.parent_task_id && !this._get('SELECT 1 FROM tasks WHERE id = ?', a.parent_task_id)) {
      throw err('not_found', 'no such parent task', 404);
    }
    if (a.idempotency_key) {
      const dup = this._get('SELECT * FROM messages WHERE sender_id = ? AND idempotency_key = ?', actor.id, String(a.idempotency_key));
      if (dup?.task_id) return { task: this.taskView(this._get('SELECT * FROM tasks WHERE id = ?', dup.task_id)), duplicate: true };
    }
    const id = newId('task');
    const t = now();
    this._run(
      `INSERT INTO tasks(id, conversation_id, title, instructions, creator_id, assignee_id, status, context_id, parent_task_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, conv.id, String(a.title).slice(0, 200), a.instructions ? String(a.instructions) : null, actor.id,
      assignee.id, 'pending', a.context_id || null, a.parent_task_id || null, t, t,
    );
    this.audit(actor, 'task.created', id, { assignee: assignee.handle }, this._ownerId(assignee));
    this._post(actor, conv, {
      kind: 'task', task_id: id, context_id: a.context_id || null, idempotency_key: a.idempotency_key,
      notify: [assignee.id],
      text: `[Task ${id}] for @${assignee.handle}: ${a.title}${a.instructions ? `\n${a.instructions}` : ''}`,
    });
    return { task: this.taskView(this._get('SELECT * FROM tasks WHERE id = ?', id)) };
  }

  _task(actor, id) {
    const t = this._get('SELECT * FROM tasks WHERE id = ?', id);
    if (!t) throw err('not_found', 'no such task', 404);
    if (!this._canRead(actor, t.conversation_id)) throw err('forbidden', 'not your task', 403);
    return t;
  }

  getTask(actor, id) { return this.taskView(this._task(actor, id)); }

  /** Tasks this principal delegated that are still awaiting the assignee. */
  openDelegatedCount(actor) {
    return this._get(
      `SELECT COUNT(*) AS n FROM tasks WHERE creator_id = ? AND status IN ('pending','accepted','in_progress')`, actor.id,
    ).n;
  }

  listTasks(actor, { conversation_id, status } = {}) {
    const ids = this._scopeIds(actor);
    const marks = ids.map(() => '?').join(',');
    let rows = conversation_id
      ? (this._requireRead(actor, conversation_id), this._all('SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at DESC', conversation_id))
      : this._all(`SELECT * FROM tasks WHERE creator_id IN (${marks}) OR assignee_id IN (${marks}) ORDER BY created_at DESC LIMIT 200`, ...ids, ...ids);
    if (status) rows = rows.filter((t) => t.status === status);
    return rows.map((t) => this.taskView(t));
  }

  updateTask(actor, { task_id, status, result, note } = {}) {
    const t = this._task(actor, task_id);
    if (!TASK_STATUSES.includes(status)) throw err('invalid', `status must be one of ${TASK_STATUSES.join(', ')}`);
    if (['completed', 'cancelled'].includes(t.status)) throw err('invalid', `task is already ${t.status}`);
    const asAssignee = this._onSide(actor, t.assignee_id), asCreator = this._onSide(actor, t.creator_id);
    const allowed = (asAssignee && ASSIGNEE_STATUSES.includes(status))
      || (asCreator && (status === 'cancelled' || (status === 'pending' && ['failed', 'needs_input'].includes(t.status))));
    if (!allowed) {
      this.audit(actor, 'task.update_denied', t.id, { status });
      throw err('forbidden', 'assignee may set accepted/in_progress/needs_input/completed/failed; creator may cancel or re-open (pending)', 403);
    }
    if (result != null && Buffer.byteLength(String(result)) > this.limits.maxContextBytes) throw err('too_large', 'result too large', 413);
    this._run('UPDATE tasks SET status = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?',
      status, result != null ? String(result) : null, now(), t.id);
    this.audit(actor, 'task.updated', t.id, { from: t.status, to: status });
    const other = asAssignee ? t.creator_id : t.assignee_id;
    const preview = result ? `\n${String(result).slice(0, 500)}${String(result).length > 500 ? '… (full result: get_task)' : ''}` : '';
    // State changes must reach the other party even when the loop breaker is open.
    this._post(actor, this._conv(t.conversation_id), {
      kind: 'task', task_id: t.id, notify: [other], bypassGuards: true,
      text: `[Task ${t.id}] ${t.status} → ${status}: ${t.title}${note ? `\n${note}` : ''}${preview}`,
    });
    return { task: this.getTask(actor, t.id) };
  }
}

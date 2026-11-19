import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS principals(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  owner_id TEXT, token_hash TEXT NOT NULL UNIQUE, runtime TEXT, description TEXT,
  webhook_url TEXT, webhook_secret TEXT, created_at TEXT NOT NULL, last_seen_at TEXT);
CREATE TABLE IF NOT EXISTS connections(
  id TEXT PRIMARY KEY, requester_owner TEXT NOT NULL, target_owner TEXT NOT NULL, status TEXT NOT NULL,
  requested_by TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT,
  UNIQUE(requester_owner, target_owner));
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, dm_key TEXT UNIQUE,
  routing_mode TEXT NOT NULL DEFAULT 'mention', created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(
  conversation_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, principal_id));
CREATE TABLE IF NOT EXISTS messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL, reply_to TEXT,
  context_id TEXT, task_id TEXT, idempotency_key TEXT, created_at TEXT NOT NULL,
  UNIQUE(sender_id, idempotency_key));
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS deliveries(
  message_id TEXT NOT NULL, recipient_id TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, acked_at TEXT,
  PRIMARY KEY(message_id, recipient_id));
CREATE INDEX IF NOT EXISTS del_rcpt ON deliveries(recipient_id, status);
CREATE TABLE IF NOT EXISTS contexts(
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, version INTEGER NOT NULL, creator_id TEXT NOT NULL,
  conversation_id TEXT, payload TEXT NOT NULL, recipients TEXT NOT NULL, expires_at TEXT,
  revoked_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT,
  creator_id TEXT NOT NULL, assignee_id TEXT NOT NULL, status TEXT NOT NULL, context_id TEXT,
  parent_task_id TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_id TEXT, owner_id TEXT,
  affects_owner TEXT, action TEXT NOT NULL, target TEXT, detail TEXT);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Columns added after the first release; ALTER keeps existing databases working.
  const cols = new Set(db.prepare('PRAGMA table_info(principals)').all().map((c) => c.name));
  for (const [name, type] of [['sync_minutes', 'INTEGER'], ['sync_state', "TEXT NOT NULL DEFAULT 'pending'"], ['last_inbox_at', 'TEXT'], ['contacts_seen_at', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE principals ADD COLUMN ${name} ${type}`);
  }
  return db;
}

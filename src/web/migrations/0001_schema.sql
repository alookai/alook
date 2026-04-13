-- Better Auth managed tables (camelCase columns as expected by Better Auth)
CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER,
  image TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "session" (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "account" (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  accessToken TEXT,
  refreshToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  idToken TEXT,
  password TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "verification" (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workspaces
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Members
CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, user_id)
);

-- Agent Runtimes
CREATE TABLE IF NOT EXISTS agent_runtime (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  daemon_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  runtime_mode TEXT NOT NULL DEFAULT 'local',
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  device_info TEXT NOT NULL DEFAULT '',
  metadata TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, daemon_id, provider)
);

-- Agents
CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  runtime_id TEXT REFERENCES agent_runtime(id),
  runtime_mode TEXT NOT NULL DEFAULT 'local',
  runtime_config TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'idle',
  max_concurrent_tasks INTEGER NOT NULL DEFAULT 6,
  owner_id TEXT REFERENCES "user"(id),
  tools TEXT,
  triggers TEXT,
  email_handle TEXT UNIQUE,
  forward_to_email TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent Whitelist
CREATE TABLE IF NOT EXISTS agent_whitelist (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, email)
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Messages
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent Task Queue
CREATE TABLE IF NOT EXISTS agent_task_queue (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL REFERENCES agent_runtime(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  context TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dispatched_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_per_conversation
  ON agent_task_queue(conversation_id)
  WHERE status IN ('queued', 'dispatched');

CREATE INDEX IF NOT EXISTS idx_task_queue_pending
  ON agent_task_queue(agent_id, status)
  WHERE status IN ('queued', 'dispatched');

-- Task Messages
CREATE TABLE IF NOT EXISTS task_message (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  call_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  input TEXT,
  output TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_message_task_seq ON task_message(task_id, seq);

-- Emails
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,
  is_whitelisted INTEGER NOT NULL DEFAULT 0,
  forwarded INTEGER NOT NULL DEFAULT 0,
  html_body TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Machine Tokens
CREATE TABLE IF NOT EXISTS machine_token (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_machine_token ON machine_token(token);

-- Better Auth indexes
CREATE INDEX IF NOT EXISTS idx_session_user_id ON "session"(userId);
CREATE INDEX IF NOT EXISTS idx_session_token ON "session"(token);
CREATE INDEX IF NOT EXISTS idx_account_user_id ON "account"(userId);

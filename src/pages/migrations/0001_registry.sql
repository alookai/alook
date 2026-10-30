CREATE TABLE pages (
  id TEXT PRIMARY KEY NOT NULL,
  prefix TEXT NOT NULL UNIQUE CHECK (
    prefix = lower(prefix) AND length(prefix) BETWEEN 1 AND 63
    AND prefix NOT GLOB '*[^a-z0-9-]*'
    AND substr(prefix, 1, 1) GLOB '[a-z0-9]'
    AND substr(prefix, -1) GLOB '[a-z0-9]'
  ),
  namespace TEXT NOT NULL,
  account TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('publishing', 'ready', 'failed', 'deleting')),
  active TEXT,
  releases TEXT NOT NULL,
  operation TEXT NOT NULL,
  current_op TEXT,
  stage TEXT,
  error TEXT,
  revision INTEGER NOT NULL,
  version INTEGER NOT NULL,
  limits TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pages_namespace ON pages(namespace, account);

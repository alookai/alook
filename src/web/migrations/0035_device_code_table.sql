CREATE TABLE IF NOT EXISTS device_code (
  id TEXT PRIMARY KEY NOT NULL,
  device_code TEXT NOT NULL,
  user_code TEXT NOT NULL,
  user_id TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  last_polled_at TEXT,
  polling_interval INTEGER,
  client_id TEXT,
  scope TEXT
);

PRAGMA defer_foreign_keys=ON;

CREATE TABLE community_machine_backend_quota_new (
  machine_id TEXT NOT NULL REFERENCES community_machine(id) ON DELETE CASCADE,
  agent_backend_id TEXT NOT NULL CHECK (agent_backend_id IN ('claude', 'codex', 'grok')),
  source_epoch TEXT NOT NULL CHECK (length(source_epoch) = 22 AND source_epoch NOT GLOB '*[^A-Za-z0-9_-]*'),
  status TEXT NOT NULL CHECK (status IN ('available', 'error')),
  plan_name TEXT,
  fresh_for_seconds INTEGER,
  limits TEXT,
  error_code TEXT,
  retryable INTEGER,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, agent_backend_id),
  CHECK (
    (status = 'available' AND fresh_for_seconds BETWEEN 1 AND 86400 AND json_valid(limits) AND json_array_length(limits) BETWEEN 1 AND 8 AND error_code IS NULL AND retryable IS NULL)
    OR
    (status = 'error' AND plan_name IS NULL AND fresh_for_seconds IS NULL AND limits IS NULL AND error_code IN ('unavailable', 'unauthorized', 'network', 'provider_error', 'invalid_response') AND retryable IN (0, 1))
  )
);

INSERT INTO community_machine_backend_quota_new (
  machine_id,
  agent_backend_id,
  source_epoch,
  status,
  plan_name,
  fresh_for_seconds,
  limits,
  error_code,
  retryable,
  observed_at,
  updated_at
)
SELECT
  machine_id,
  agent_backend_id,
  source_epoch,
  status,
  plan_name,
  fresh_for_seconds,
  limits,
  error_code,
  retryable,
  observed_at,
  updated_at
FROM community_machine_backend_quota;

DROP TABLE community_machine_backend_quota;
ALTER TABLE community_machine_backend_quota_new RENAME TO community_machine_backend_quota;

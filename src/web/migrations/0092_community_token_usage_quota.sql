CREATE TABLE community_bot_daily_token_usage (
  bot_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  cache_tokens INTEGER CHECK (cache_tokens IS NULL OR (typeof(cache_tokens) = 'integer' AND cache_tokens >= 0)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, day),
  CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

CREATE INDEX idx_community_bot_daily_token_usage_day
  ON community_bot_daily_token_usage(day);

CREATE TABLE community_machine_backend_quota (
  machine_id TEXT NOT NULL REFERENCES community_machine(id) ON DELETE CASCADE,
  agent_backend_id TEXT NOT NULL CHECK (agent_backend_id IN ('claude', 'codex')),
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

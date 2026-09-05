CREATE TABLE native_oauth_attempt (
  id TEXT PRIMARY KEY NOT NULL,
  instance_key_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  provider TEXT NOT NULL,
  platform TEXT NOT NULL,
  redirect_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  handoff_code_hash TEXT,
  handoff_expires_at INTEGER,
  auth_kind TEXT,
  failure_code TEXT,
  attempt_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  opened_at INTEGER,
  ready_at INTEGER,
  consumed_at INTEGER,
  failed_at INTEGER,
  cancelled_at INTEGER,
  replaced_at INTEGER,
  CONSTRAINT ck_native_oauth_attempt_id CHECK (
    length(id) BETWEEN 22 AND 64
    AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CONSTRAINT ck_native_oauth_attempt_hashes CHECK (
    length(instance_key_hash) = 64
    AND instance_key_hash NOT GLOB '*[^0-9a-f]*'
    AND length(state_hash) = 64
    AND state_hash NOT GLOB '*[^0-9a-f]*'
    AND length(pkce_challenge) = 43
    AND pkce_challenge NOT GLOB '*[^A-Za-z0-9_-]*'
    AND (
      handoff_code_hash IS NULL
      OR (
        length(handoff_code_hash) = 64
        AND handoff_code_hash NOT GLOB '*[^0-9a-f]*'
      )
    )
  ),
  CONSTRAINT ck_native_oauth_attempt_enums CHECK (
    provider IN ('github', 'google')
    AND platform IN ('macos', 'windows', 'linux', 'ios', 'android')
    AND status IN (
      'pending', 'opened', 'ready', 'exchanging',
      'consumed', 'failed', 'cancelled', 'replaced'
    )
    AND (auth_kind IS NULL OR auth_kind IN ('signin', 'signup'))
    AND (
      failure_code IS NULL
      OR failure_code IN (
        'access_denied', 'provider_error', 'oauth_callback_failed',
        'start_failed', 'invalid_handoff'
      )
    )
  ),
  CONSTRAINT ck_native_oauth_attempt_redirect CHECK (
    length(redirect_path) BETWEEN 1 AND 2048
    AND substr(redirect_path, 1, 1) = '/'
    AND substr(redirect_path, 1, 2) <> '//'
    AND instr(redirect_path, char(92)) = 0
  ),
  CONSTRAINT ck_native_oauth_attempt_epochs CHECK (
    typeof(created_at) = 'integer'
    AND created_at BETWEEN 0 AND 9007199254740991
    AND typeof(updated_at) = 'integer'
    AND updated_at BETWEEN created_at AND 9007199254740991
    AND typeof(attempt_expires_at) = 'integer'
    AND attempt_expires_at = created_at + 600000
    AND (
      handoff_expires_at IS NULL
      OR (
        typeof(handoff_expires_at) = 'integer'
        AND handoff_expires_at <= attempt_expires_at
      )
    )
  ),
  CONSTRAINT ck_native_oauth_attempt_state CHECK (
    (
      status = 'pending'
      AND opened_at IS NULL AND ready_at IS NULL AND consumed_at IS NULL
      AND failed_at IS NULL AND cancelled_at IS NULL AND replaced_at IS NULL
      AND handoff_code_hash IS NULL AND handoff_expires_at IS NULL
      AND auth_kind IS NULL AND failure_code IS NULL
    ) OR (
      status = 'opened'
      AND opened_at IS NOT NULL AND ready_at IS NULL AND consumed_at IS NULL
      AND failed_at IS NULL AND cancelled_at IS NULL AND replaced_at IS NULL
      AND handoff_code_hash IS NULL AND handoff_expires_at IS NULL
      AND auth_kind IS NULL AND failure_code IS NULL
    ) OR (
      status IN ('ready', 'exchanging')
      AND opened_at IS NOT NULL AND ready_at IS NOT NULL AND consumed_at IS NULL
      AND failed_at IS NULL AND cancelled_at IS NULL AND replaced_at IS NULL
      AND handoff_code_hash IS NOT NULL AND handoff_expires_at IS NOT NULL
      AND handoff_expires_at = ready_at + 120000
      AND auth_kind IS NOT NULL AND failure_code IS NULL
    ) OR (
      status = 'consumed'
      AND opened_at IS NOT NULL AND ready_at IS NOT NULL AND consumed_at IS NOT NULL
      AND failed_at IS NULL AND cancelled_at IS NULL AND replaced_at IS NULL
      AND handoff_code_hash IS NOT NULL AND handoff_expires_at IS NOT NULL
      AND auth_kind IS NOT NULL AND failure_code IS NULL
    ) OR (
      status = 'failed'
      AND consumed_at IS NULL AND failed_at IS NOT NULL
      AND cancelled_at IS NULL AND replaced_at IS NULL
      AND failure_code IS NOT NULL
    ) OR (
      status = 'cancelled'
      AND consumed_at IS NULL AND cancelled_at IS NOT NULL
      AND failed_at IS NULL AND replaced_at IS NULL
      AND failure_code IS NULL
    ) OR (
      status = 'replaced'
      AND consumed_at IS NULL AND replaced_at IS NOT NULL
      AND failed_at IS NULL AND cancelled_at IS NULL
      AND failure_code IS NULL
    )
  )
) WITHOUT ROWID;

CREATE INDEX idx_native_oauth_attempt_instance_status
  ON native_oauth_attempt(instance_key_hash, status);

CREATE INDEX idx_native_oauth_attempt_id_status_expiry
  ON native_oauth_attempt(id, status, attempt_expires_at);

CREATE INDEX idx_native_oauth_attempt_terminal_cleanup
  ON native_oauth_attempt(status, updated_at);

CREATE UNIQUE INDEX uq_native_oauth_attempt_instance_live
  ON native_oauth_attempt(instance_key_hash)
  WHERE status IN ('pending', 'opened', 'ready', 'exchanging');

CREATE UNIQUE INDEX uq_native_oauth_attempt_handoff_hash
  ON native_oauth_attempt(handoff_code_hash)
  WHERE handoff_code_hash IS NOT NULL;

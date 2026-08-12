CREATE TABLE community_diagnostic_report (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  client_nonce TEXT NOT NULL,
  rate_bucket INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  failure_code TEXT,
  from_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  completed_at INTEGER,
  r2_key TEXT,
  sha256 TEXT,
  size_bytes INTEGER,
  uploaded_at INTEGER,
  object_expires_at INTEGER,
  CONSTRAINT ck_community_diagnostic_report_id CHECK (
    length(id) > 4
    AND substr(id, 1, 4) = 'dbr_'
    AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CONSTRAINT ck_community_diagnostic_report_nonce CHECK (
    length(client_nonce) BETWEEN 16 AND 64
    AND client_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CONSTRAINT ck_community_diagnostic_report_required_epochs CHECK (
    typeof(from_ms) = 'integer' AND from_ms BETWEEN 0 AND 9007199254740991
    AND typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991
    AND typeof(deadline_at) = 'integer' AND deadline_at BETWEEN 0 AND 9007199254740991
    AND from_ms = created_at - 86400000
    AND deadline_at = created_at + 600000
  ),
  CONSTRAINT ck_community_diagnostic_report_rate_bucket CHECK (
    typeof(rate_bucket) = 'integer'
    AND rate_bucket BETWEEN 0 AND 9007199254740991
    AND rate_bucket = CAST(created_at / 60000 AS INTEGER)
  ),
  CONSTRAINT ck_community_diagnostic_report_nullable_epochs CHECK (
    (completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at BETWEEN 0 AND 9007199254740991))
    AND (uploaded_at IS NULL OR (typeof(uploaded_at) = 'integer' AND uploaded_at BETWEEN 0 AND 9007199254740991))
    AND (object_expires_at IS NULL OR (typeof(object_expires_at) = 'integer' AND object_expires_at BETWEEN 0 AND 9007199254740991))
  ),
  CONSTRAINT ck_community_diagnostic_report_size CHECK (
    size_bytes IS NULL
    OR (typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 1 AND 10485760)
  ),
  CONSTRAINT ck_community_diagnostic_report_sha256 CHECK (
    sha256 IS NULL
    OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CONSTRAINT ck_community_diagnostic_report_state CHECK (
    (
      status = 'pending'
      AND failure_code IS NULL AND completed_at IS NULL
      AND r2_key IS NULL AND sha256 IS NULL AND size_bytes IS NULL
      AND uploaded_at IS NULL AND object_expires_at IS NULL
    ) OR (
      status = 'failed'
      AND failure_code IN (
        'offline', 'timeout', 'upload_conflict', 'invalid_upload',
        'diagnostics_unavailable', 'collector_busy', 'bot_not_bound',
        'collection_failed', 'local_artifact_invalid', 'bundle_too_large',
        'upload_failed', 'internal_error'
      )
      AND completed_at IS NOT NULL
      AND completed_at >= created_at
      AND r2_key IS NULL AND sha256 IS NULL AND size_bytes IS NULL
      AND uploaded_at IS NULL AND object_expires_at IS NULL
    ) OR (
      status = 'uploaded'
      AND failure_code IS NULL AND completed_at IS NOT NULL
      AND completed_at >= created_at
      AND r2_key IS NOT NULL
      AND r2_key = 'bug-reports/' || owner_user_id || '/' || id || '.ndjson.gz'
      AND sha256 IS NOT NULL AND size_bytes IS NOT NULL
      AND uploaded_at IS NOT NULL AND object_expires_at IS NOT NULL
      AND completed_at = uploaded_at
      AND object_expires_at = uploaded_at + 604800000
    )
  )
) WITHOUT ROWID;

CREATE INDEX idx_community_diagnostic_report_owner_created
  ON community_diagnostic_report(owner_user_id, created_at);

CREATE INDEX idx_community_diagnostic_report_machine_status_deadline
  ON community_diagnostic_report(machine_id, status, deadline_at);

CREATE UNIQUE INDEX uq_community_diagnostic_report_owner_nonce
  ON community_diagnostic_report(owner_user_id, client_nonce);

CREATE UNIQUE INDEX uq_community_diagnostic_report_owner_agent_pending
  ON community_diagnostic_report(owner_user_id, agent_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX uq_community_diagnostic_report_owner_rate_bucket
  ON community_diagnostic_report(owner_user_id, rate_bucket);

CREATE TRIGGER trg_community_diagnostic_report_update
BEFORE UPDATE ON community_diagnostic_report
FOR EACH ROW
WHEN OLD.status <> 'pending'
  OR NEW.status = 'pending'
  OR NEW.id IS NOT OLD.id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.machine_id IS NOT OLD.machine_id
  OR NEW.client_nonce IS NOT OLD.client_nonce
  OR NEW.rate_bucket IS NOT OLD.rate_bucket
  OR NEW.from_ms IS NOT OLD.from_ms
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.deadline_at IS NOT OLD.deadline_at
BEGIN
  SELECT RAISE(ABORT, 'community diagnostic report immutable');
END;

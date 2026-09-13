CREATE TABLE community_push_device (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL CONSTRAINT ck_push_device_platform
    CHECK (platform IN ('ios', 'android')),
  provider_environment TEXT NOT NULL CONSTRAINT ck_push_device_provider_environment
    CHECK (provider_environment IN ('sandbox', 'production')),
  provider_token_encrypted TEXT NOT NULL,
  provider_token_hash TEXT NOT NULL CONSTRAINT ck_push_device_token_hash
    CHECK (
      length(provider_token_hash) = 64
      AND provider_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
  app_version TEXT,
  last_seen_at TEXT NOT NULL,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT ck_push_device_android_environment
    CHECK (platform = 'ios' OR provider_environment = 'production')
);

CREATE UNIQUE INDEX uq_push_device_installation
  ON community_push_device(installation_id);

CREATE INDEX idx_push_device_user_active
  ON community_push_device(user_id, disabled_at);

CREATE INDEX idx_push_device_token_hash
  ON community_push_device(provider_token_hash);

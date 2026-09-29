CREATE TABLE billing_analytics_consent (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CONSTRAINT ck_billing_analytics_consent_decision
    CHECK (decision IN ('granted', 'denied')),
  source_version INTEGER NOT NULL CONSTRAINT ck_billing_analytics_consent_source_version
    CHECK (source_version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_billing_analytics_consent_revision
    CHECK (revision > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE billing_purchase_delivery (
  invoice_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  status TEXT NOT NULL CONSTRAINT ck_billing_purchase_delivery_status
    CHECK (status IN ('claimed', 'sent', 'failed', 'skipped')),
  reason TEXT NOT NULL CONSTRAINT ck_billing_purchase_delivery_reason
    CHECK (length(reason) BETWEEN 1 AND 64),
  purchase_type TEXT CONSTRAINT ck_billing_purchase_delivery_type
    CHECK (purchase_type IS NULL OR purchase_type IN ('initial_subscription', 'renewal', 'upgrade', 'other')),
  currency TEXT,
  value_minor INTEGER,
  plan_id TEXT,
  validation_json TEXT CONSTRAINT ck_billing_purchase_delivery_validation
    CHECK (validation_json IS NULL OR length(validation_json) <= 10000),
  claimed_at TEXT NOT NULL,
  finalized_at TEXT,
  CONSTRAINT ck_billing_purchase_delivery_finalization CHECK (
    (status = 'claimed' AND finalized_at IS NULL)
    OR (status != 'claimed' AND finalized_at IS NOT NULL)
  )
);

CREATE INDEX idx_billing_purchase_delivery_user_claimed
  ON billing_purchase_delivery(user_id, claimed_at);

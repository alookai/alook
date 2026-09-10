ALTER TABLE user_product_plan
  ADD COLUMN is_founder INTEGER NOT NULL DEFAULT 0 CHECK (is_founder IN (0, 1));

UPDATE user_product_plan SET is_founder = 1
WHERE plan_id = 'house'
  AND user_id IN (SELECT id FROM "user" WHERE isBot = 0);

CREATE TABLE billing_price (
  price_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES product_plan(id) ON DELETE RESTRICT,
  portal_configuration_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE user_billing (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  customer_id TEXT,
  subscription_id TEXT,
  subscription_json TEXT CHECK (subscription_json IS NULL OR json_valid(subscription_json)),
  revision INTEGER NOT NULL DEFAULT 0,
  apply_token TEXT,
  checkout_attempt_json TEXT CHECK (checkout_attempt_json IS NULL OR json_valid(checkout_attempt_json)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX uq_user_billing_customer ON user_billing(customer_id);
CREATE UNIQUE INDEX uq_user_billing_subscription ON user_billing(subscription_id);

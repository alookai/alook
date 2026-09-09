-- Extensible product-plan catalog. Plans and their entitlements are data, not
-- application enums: adding a tier or entitlement does not change this schema.
CREATE TABLE product_plan (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX uq_product_plan_active_default
  ON product_plan(is_default)
  WHERE is_default = 1 AND is_active = 1;

CREATE TABLE product_plan_entitlement (
  plan_id TEXT NOT NULL REFERENCES product_plan(id) ON DELETE CASCADE,
  entitlement_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plan_id, entitlement_key)
);

CREATE INDEX idx_product_plan_entitlement_key
  ON product_plan_entitlement(entitlement_key, plan_id);

CREATE TABLE user_product_plan (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES product_plan(id) ON DELETE RESTRICT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_user_product_plan_plan
  ON user_product_plan(plan_id);

-- Initial commercial catalog. These ids and values are replaceable product
-- data; application policy resolves only entitlement keys such as `bots.max`.
INSERT INTO product_plan (id, display_name, is_default, is_active, sort_order)
VALUES
  ('free', 'Free', 1, 1, 10),
  ('studio', 'Studio', 0, 1, 20),
  ('house', 'House', 0, 1, 30);

INSERT INTO product_plan_entitlement (plan_id, entitlement_key, value_json)
VALUES
  ('free', 'bots.max', '3'),
  ('studio', 'bots.max', '10'),
  ('house', 'bots.max', '40');

ALTER TABLE community_bot_binding
  ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));

CREATE INDEX idx_community_bot_binding_machine_active
  ON community_bot_binding(machine_id, is_active);

-- Rollout compatibility: every human that already exists keeps the current
-- product capability through an explicit House assignment. Users created
-- after this migration have no row and therefore resolve through Free, the
-- active default. Existing bot bindings keep the new column's DEFAULT 1.
INSERT INTO user_product_plan (user_id, plan_id)
SELECT id, 'house'
FROM "user"
WHERE isBot = 0;

-- Database backstop for concurrent creates. Domain code still performs the
-- friendly preflight and returns plan evidence, but this trigger is the final
-- authority if two requests race the same remaining slot.
CREATE TRIGGER enforce_owned_bot_entitlement_before_insert
BEFORE INSERT ON "user"
WHEN NEW.isBot = 1 AND (
  SELECT COUNT(*)
  FROM "user" existing
  WHERE existing.ownerUserId = NEW.ownerUserId
    AND existing.isBot = 1
    AND existing.deletedAt IS NULL
) >= COALESCE((
  SELECT CAST(e.value_json AS INTEGER)
  FROM product_plan_entitlement e
  INNER JOIN product_plan p ON p.id = e.plan_id AND p.is_active = 1
  LEFT JOIN user_product_plan up ON up.user_id = NEW.ownerUserId
  WHERE e.entitlement_key = 'bots.max'
    AND json_type(e.value_json) = 'integer'
    AND CAST(e.value_json AS INTEGER) >= 0
    AND p.id = COALESCE(
      up.plan_id,
      (SELECT id FROM product_plan WHERE is_default = 1 AND is_active = 1 LIMIT 1)
    )
  LIMIT 1
), 0)
BEGIN
  SELECT RAISE(ABORT, 'BOT_ENTITLEMENT_LIMIT_REACHED');
END;

-- Same backstop for two concurrent owner activation requests.
CREATE TRIGGER enforce_active_bot_entitlement_before_update
BEFORE UPDATE OF is_active ON community_bot_binding
WHEN NEW.is_active = 1 AND OLD.is_active = 0 AND (
  SELECT COUNT(*)
  FROM community_bot_binding active_binding
  INNER JOIN "user" active_bot ON active_bot.id = active_binding.user_id
  WHERE active_bot.ownerUserId = (
    SELECT ownerUserId FROM "user" WHERE id = NEW.user_id
  )
    AND active_bot.isBot = 1
    AND active_bot.deletedAt IS NULL
    AND active_binding.is_active = 1
) >= COALESCE((
  SELECT CAST(e.value_json AS INTEGER)
  FROM product_plan_entitlement e
  INNER JOIN product_plan p ON p.id = e.plan_id AND p.is_active = 1
  LEFT JOIN user_product_plan up ON up.user_id = (
    SELECT ownerUserId FROM "user" WHERE id = NEW.user_id
  )
  WHERE e.entitlement_key = 'bots.max'
    AND json_type(e.value_json) = 'integer'
    AND CAST(e.value_json AS INTEGER) >= 0
    AND p.id = COALESCE(
      up.plan_id,
      (SELECT id FROM product_plan WHERE is_default = 1 AND is_active = 1 LIMIT 1)
    )
  LIMIT 1
), 0)
BEGIN
  SELECT RAISE(ABORT, 'BOT_ENTITLEMENT_LIMIT_REACHED');
END;

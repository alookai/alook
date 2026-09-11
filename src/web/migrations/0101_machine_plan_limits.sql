INSERT INTO product_plan_entitlement (plan_id, entitlement_key, value_json)
VALUES ('free', 'machines.max', '1'), ('studio', 'machines.max', '5'), ('house', 'machines.max', '10');

CREATE TRIGGER enforce_owned_machine_entitlement_before_insert
BEFORE INSERT ON community_machine
WHEN (SELECT COUNT(*) FROM community_machine existing WHERE existing.user_id = NEW.user_id) >= COALESCE((
  SELECT CAST(e.value_json AS INTEGER)
  FROM product_plan_entitlement e
  INNER JOIN product_plan p ON p.id = e.plan_id AND p.is_active = 1
  LEFT JOIN user_product_plan up ON up.user_id = NEW.user_id
  WHERE e.entitlement_key = 'machines.max'
    AND json_type(e.value_json) = 'integer'
    AND CAST(e.value_json AS INTEGER) >= 0
    AND p.id = COALESCE(up.plan_id, (SELECT id FROM product_plan WHERE is_default = 1 AND is_active = 1 LIMIT 1))
  LIMIT 1
), 0)
BEGIN
  SELECT RAISE(ABORT, 'MACHINE_LIMIT_REACHED');
END;

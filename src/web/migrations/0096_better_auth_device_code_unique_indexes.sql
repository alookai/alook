-- Better Auth 1.7 requires each standalone Device Authorization lookup code
-- to identify exactly one request. Existing rows must be checked for
-- duplicates before this migration is applied; index creation then fails
-- closed if a duplicate appears during the cutover.
CREATE UNIQUE INDEX IF NOT EXISTS "deviceCode_deviceCode_uidx"
  ON "deviceCode" ("deviceCode");

CREATE UNIQUE INDEX IF NOT EXISTS "deviceCode_userCode_uidx"
  ON "deviceCode" ("userCode");

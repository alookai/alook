CREATE TABLE IF NOT EXISTS "deviceCode" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "deviceCode" TEXT NOT NULL,
  "userCode" TEXT NOT NULL,
  "userId" TEXT,
  "expiresAt" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "lastPolledAt" TEXT,
  "pollingInterval" INTEGER,
  "clientId" TEXT,
  "scope" TEXT
);

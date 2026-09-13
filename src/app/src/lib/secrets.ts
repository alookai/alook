import { existsSync, writeFileSync, readFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { SELF_HOSTED_DIR } from "./constants.js";

function generateSecret(): string {
  return randomBytes(32).toString("base64");
}

function extractKey(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function setKey(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}`;
  return `${next.trimEnd()}\n`;
}

function syncWorkerVars(filePath: string, encryptionKey: string, emptyKeys: string[] = []): void {
  let content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  content = setKey(content, "ENCRYPTION_KEY", encryptionKey);
  for (const key of emptyKeys) {
    if (extractKey(filePath, key) === null && !new RegExp(`^${key}=`, "m").test(content)) {
      content = setKey(content, key, "");
    }
  }
  writeFileSync(filePath, content, { mode: 0o600 });
}

export function ensureSecrets(webPort: number): void {
  const webVars = join(SELF_HOSTED_DIR, "web", ".dev.vars");
  const emailVars = join(SELF_HOSTED_DIR, "email-worker", ".dev.vars");
  const queueVars = join(SELF_HOSTED_DIR, "queue-worker", ".dev.vars");

  if (!existsSync(webVars)) {
    const authSecret = generateSecret();
    const encryptionKey = generateSecret();
    const content = [
      `BETTER_AUTH_SECRET=${authSecret}`,
      `BETTER_AUTH_URL=http://localhost:${webPort}`,
      `ENCRYPTION_KEY=${encryptionKey}`,
      `GITHUB_CLIENT_ID=`,
      `GITHUB_CLIENT_SECRET=`,
      `GOOGLE_CLIENT_ID=`,
      `GOOGLE_CLIENT_SECRET=`,
    ].join("\n");
    writeFileSync(webVars, `${content}\n`, { mode: 0o600 });
    console.log("Generated web secrets");
  } else {
    const existingKey = extractKey(webVars, "ENCRYPTION_KEY");
    if (!existingKey) {
      writeFileSync(
        webVars,
        setKey(readFileSync(webVars, "utf-8"), "ENCRYPTION_KEY", generateSecret()),
        { mode: 0o600 },
      );
    }
  }

  const encryptionKey = extractKey(webVars, "ENCRYPTION_KEY");
  if (!encryptionKey) throw new Error("Failed to establish the shared ENCRYPTION_KEY");

  syncWorkerVars(emailVars, encryptionKey);
  syncWorkerVars(queueVars, encryptionKey, [
    "APNS_TEAM_ID",
    "APNS_KEY_ID",
    "APNS_PRIVATE_KEY",
    "APNS_TOPIC",
    "FCM_PROJECT_ID",
    "FCM_CLIENT_EMAIL",
    "FCM_PRIVATE_KEY",
  ]);
  console.log("Synced worker secrets from web");
}

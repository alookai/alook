import { existsSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { SELF_HOSTED_DIR } from "./constants.js";

function generateSecret(): string {
  return randomBytes(32).toString("base64");
}

export function ensureSecrets(webPort: number): void {
  const webVars = join(SELF_HOSTED_DIR, "web", ".dev.vars");
  const emailVars = join(SELF_HOSTED_DIR, "email-worker", ".dev.vars");

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
    writeFileSync(webVars, content, { mode: 0o600 });
    console.log("Generated web secrets");

    writeFileSync(emailVars, `ENCRYPTION_KEY=${encryptionKey}\n`, { mode: 0o600 });
    console.log("Generated email-worker secrets");
  } else {
    console.log("Secrets already exist, skipping");
  }
}

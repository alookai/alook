import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function fillEmptyKey(content, key, value) {
  return content.replace(new RegExp(`^${key}=$`, "m"), `${key}=${value}`);
}

export function readKey(content, key) {
  return content.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";
}

export function generateDevVars({ webVars, webExample, emailVars, emailExample }) {
  if (!existsSync(webVars)) {
    copyFileSync(webExample, webVars);
    let content = readFileSync(webVars, "utf8");
    content = fillEmptyKey(content, "BETTER_AUTH_SECRET", randomBytes(32).toString("base64"));
    content = fillEmptyKey(content, "ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    writeFileSync(webVars, content);
    console.log("✓ Generated src/web/.dev.vars (fill in OAuth keys if needed)");
  }
  if (!existsSync(emailVars)) {
    copyFileSync(emailExample, emailVars);
    const key = readKey(readFileSync(webVars, "utf8"), "ENCRYPTION_KEY");
    const content = fillEmptyKey(readFileSync(emailVars, "utf8"), "ENCRYPTION_KEY", key);
    writeFileSync(emailVars, content);
    console.log("✓ Generated src/email-worker/.dev.vars (synced ENCRYPTION_KEY from web)");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateDevVars({
    webVars: join(root, "src/web/.dev.vars"),
    webExample: join(root, "src/web/.dev.vars.example"),
    emailVars: join(root, "src/email-worker/.dev.vars"),
    emailExample: join(root, "src/email-worker/.dev.vars.example"),
  });
}

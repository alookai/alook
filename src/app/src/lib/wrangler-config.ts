import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SELF_HOSTED_DIR } from "./constants.js";

export function patchWranglerConfigs(ports: { web: number; emailWorker: number; wsDo: number }): void {
  // Patch web wrangler.toml: replace service bindings with env vars for local dev
  const webToml = join(SELF_HOSTED_DIR, "web", "wrangler.toml");
  let webContent = readFileSync(webToml, "utf-8");

  // Add [dev] section if not present
  if (!webContent.includes("[dev]")) {
    webContent += `\n[dev]\nport = ${ports.web}\n`;
  }

  // Add vars for local service URLs
  if (!webContent.includes("DEV_WS_DO_URL")) {
    webContent = webContent.replace(
      /\[vars\]/,
      `[vars]\nDEV_WS_DO_URL = "http://localhost:${ports.wsDo}"\nDEV_EMAIL_WORKER_URL = "http://localhost:${ports.emailWorker}"`,
    );
  }

  writeFileSync(webToml, webContent);

  // Patch email-worker wrangler.toml: add [dev] section
  const emailToml = join(SELF_HOSTED_DIR, "email-worker", "wrangler.toml");
  let emailContent = readFileSync(emailToml, "utf-8");
  if (!emailContent.includes("[dev]")) {
    emailContent += `\n[dev]\nport = ${ports.emailWorker}\n`;
  }
  writeFileSync(emailToml, emailContent);

  // Patch ws-do wrangler.toml: add [dev] section
  const wsToml = join(SELF_HOSTED_DIR, "ws-do", "wrangler.toml");
  let wsContent = readFileSync(wsToml, "utf-8");
  if (!wsContent.includes("[dev]")) {
    wsContent += `\n[dev]\nport = ${ports.wsDo}\n`;
  }
  writeFileSync(wsToml, wsContent);
}

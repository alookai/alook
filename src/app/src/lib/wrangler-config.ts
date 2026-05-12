import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SELF_HOSTED_DIR } from "./constants.js";

function ensureDevSection(tomlPath: string, port: number): void {
  let content = readFileSync(tomlPath, "utf-8");
  if (!content.includes("[dev]")) {
    content += `\n[dev]\nport = ${port}\n`;
    writeFileSync(tomlPath, content);
  }
}

export function patchWranglerConfigs(ports: { web: number; emailWorker: number; wsDo: number }): void {
  const webToml = join(SELF_HOSTED_DIR, "web", "wrangler.toml");
  let webContent = readFileSync(webToml, "utf-8");

  if (!webContent.includes("[dev]")) {
    webContent += `\n[dev]\nport = ${ports.web}\n`;
  }
  if (!webContent.includes("DEV_WS_DO_URL")) {
    webContent = webContent.replace(
      /\[vars\]/,
      `[vars]\nDEV_WS_DO_URL = "http://localhost:${ports.wsDo}"\nDEV_EMAIL_WORKER_URL = "http://localhost:${ports.emailWorker}"`,
    );
  }
  writeFileSync(webToml, webContent);

  ensureDevSection(join(SELF_HOSTED_DIR, "email-worker", "wrangler.toml"), ports.emailWorker);
  ensureDevSection(join(SELF_HOSTED_DIR, "ws-do", "wrangler.toml"), ports.wsDo);
}

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SELF_HOSTED_DIR } from "./constants.js";

function deduplicateDevSection(content: string): string {
  const devIdx = content.indexOf("[dev]");
  if (devIdx === -1) return content;

  const nextSection = content.indexOf("\n[", devIdx + 1);
  const devEnd = nextSection === -1 ? content.length : nextSection;
  const before = content.slice(0, devIdx);
  const devBlock = content.slice(devIdx, devEnd);
  const after = content.slice(devEnd);

  const lines = devBlock.split("\n");
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\w+)\s*=/);
    if (match) {
      if (seen.has(match[1])) {
        lines[seen.get(match[1])!] = "";
      }
      seen.set(match[1], i);
    }
  }
  const cleaned = lines.filter((l) => l !== "").join("\n");
  return before + cleaned + after;
}

function setDevPort(tomlPath: string, port: number): void {
  let content = deduplicateDevSection(readFileSync(tomlPath, "utf-8"));
  if (content.includes("[dev]")) {
    const hasPort = /\[dev\][^\[]*?(?<!inspector_)port\s*=/.test(content);
    if (hasPort) {
      content = content.replace(/(\[dev\][^\[]*?)(?<!inspector_)port\s*=\s*\d+/, `$1port = ${port}`);
    } else {
      content = content.replace(/(\[dev\][^\[]*)/, `$1port = ${port}\n`);
    }
  } else {
    content += `\n[dev]\nport = ${port}\n`;
  }
  writeFileSync(tomlPath, content);
}

function setInspectorPort(tomlPath: string, inspectorPort: number): void {
  let content = deduplicateDevSection(readFileSync(tomlPath, "utf-8"));
  if (content.includes("inspector_port")) {
    content = content.replace(/inspector_port\s*=\s*\d+/, `inspector_port = ${inspectorPort}`);
  } else if (content.includes("[dev]")) {
    content = content.replace(/(\[dev\][^\[]*)/, `$1inspector_port = ${inspectorPort}\n`);
  } else {
    content += `\n[dev]\ninspector_port = ${inspectorPort}\n`;
  }
  writeFileSync(tomlPath, content);
}

function setVar(content: string, key: string, value: string): string {
  const pattern = new RegExp(`${key}\\s*=\\s*"[^"]*"`);
  if (pattern.test(content)) {
    return content.replace(pattern, `${key} = "${value}"`);
  }
  if (content.includes("[vars]")) {
    return content.replace(/\[vars\]/, `[vars]\n${key} = "${value}"`);
  }
  return content + `\n[vars]\n${key} = "${value}"\n`;
}

export function patchWranglerConfigs(ports: { web: number; emailWorker: number; wsDo: number }): void {
  const webToml = join(SELF_HOSTED_DIR, "web", "wrangler.toml");
  let webContent = deduplicateDevSection(readFileSync(webToml, "utf-8"));

  if (!webContent.includes("[dev]")) {
    webContent += `\n[dev]\nport = ${ports.web}\n`;
  } else {
    const hasPort = /\[dev\][^\[]*?(?<!inspector_)port\s*=/.test(webContent);
    if (hasPort) {
      webContent = webContent.replace(/(\[dev\][^\[]*?)(?<!inspector_)port\s*=\s*\d+/, `$1port = ${ports.web}`);
    } else {
      webContent = webContent.replace(/(\[dev\][^\[]*)/, `$1port = ${ports.web}\n`);
    }
  }

  webContent = setVar(webContent, "DEV_WS_DO_URL", `http://localhost:${ports.wsDo}`);
  webContent = setVar(webContent, "DEV_EMAIL_WORKER_URL", `http://localhost:${ports.emailWorker}`);
  webContent = setVar(webContent, "NODE_ENV", "development");
  writeFileSync(webToml, webContent);

  setDevPort(join(SELF_HOSTED_DIR, "email-worker", "wrangler.toml"), ports.emailWorker);
  setDevPort(join(SELF_HOSTED_DIR, "ws-do", "wrangler.toml"), ports.wsDo);

  setInspectorPort(join(SELF_HOSTED_DIR, "web", "wrangler.toml"), 19229);
  setInspectorPort(join(SELF_HOSTED_DIR, "ws-do", "wrangler.toml"), 19230);
  setInspectorPort(join(SELF_HOSTED_DIR, "email-worker", "wrangler.toml"), 19231);
}

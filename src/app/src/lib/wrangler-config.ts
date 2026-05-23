import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SELF_HOSTED_DIR } from "./constants.js";

function setDevPort(tomlPath: string, port: number): void {
  let content = readFileSync(tomlPath, "utf-8");
  if (content.includes("[dev]")) {
    const patched = content.replace(/(\[dev\][^\[]*?)(?<!inspector_)port\s*=\s*\d+/, `$1port = ${port}`);
    if (patched === content) {
      content = content.replace(/(\[dev\][^\[]*)/, `$1port = ${port}\n`);
    } else {
      content = patched;
    }
  } else {
    content += `\n[dev]\nport = ${port}\n`;
  }
  writeFileSync(tomlPath, content);
}

function setInspectorPort(tomlPath: string, inspectorPort: number): void {
  let content = readFileSync(tomlPath, "utf-8");
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
  let webContent = readFileSync(webToml, "utf-8");

  if (!webContent.includes("[dev]")) {
    webContent += `\n[dev]\nport = ${ports.web}\n`;
  } else {
    const patched = webContent.replace(/(\[dev\][^\[]*?)(?<!inspector_)port\s*=\s*\d+/, `$1port = ${ports.web}`);
    if (patched === webContent) {
      webContent = webContent.replace(/(\[dev\][^\[]*)/, `$1port = ${ports.web}\n`);
    } else {
      webContent = patched;
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

import type { DevPortProfile } from "@alook/shared";
import { SELF_HOSTED_SERVICES } from "./service-topology.js";
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
  const cleaned = lines.filter((l, i) => l !== "" || i === lines.length - 1).join("\n");
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

export function removeServiceBinding(content: string, binding: string): string {
  return content
    .split(/(?=^\[\[?[^\n]+\]\]?\s*$)/m)
    .filter((section) => {
      if (!section.startsWith("[[services]]")) return true;
      return !new RegExp(`^binding\\s*=\\s*"${binding}"$`, "m").test(section);
    })
    .join("");
}

export function patchWranglerConfigs(ports: DevPortProfile): void {
  const webToml = join(SELF_HOSTED_DIR, "web", "wrangler.toml");
  setDevPort(webToml, ports.web);
  let webContent = readFileSync(webToml, "utf-8");

  for (const service of SELF_HOSTED_SERVICES) {
    if ("urlVariable" in service) webContent = setVar(webContent, service.urlVariable, `http://localhost:${ports[service.key]}`);
  }
  webContent = setVar(webContent, "NODE_ENV", "development");
  webContent = setVar(webContent, "BLOG_DISCOVERY_REQUIRED", "false");
  webContent = removeServiceBinding(webContent, "BLOG_WORKER");
  writeFileSync(webToml, webContent);

  for (const service of SELF_HOSTED_SERVICES) {
    const config = join(SELF_HOSTED_DIR, service.directory, "wrangler.toml");
    if (service.key !== "web") setDevPort(config, ports[service.key]);
    setInspectorPort(config, service.inspectorPort);
  }
}

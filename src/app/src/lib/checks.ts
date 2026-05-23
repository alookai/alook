import { execSync } from "child_process";
import { createConnection } from "net";

export function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 20) {
    console.error(`Error: Node.js >= 20 required (found ${process.versions.node})`);
    process.exit(1);
  }
}

export function checkAIRuntime(): { type: string; version: string }[] {
  const found: { type: string; version: string }[] = [];
  for (const type of ["claude", "codex", "opencode"]) {
    try {
      const check = process.platform === "win32" ? `where ${type}` : `which ${type}`;
      execSync(check, { stdio: "ignore" });
      let version = "";
      try {
        version = execSync(`${type} --version`, { encoding: "utf-8" }).trim();
      } catch {}
      found.push({ type, version });
    } catch {}
  }
  return found;
}

export async function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ port, host: "127.0.0.1" });
    conn.on("connect", () => { conn.destroy(); resolve(false); });
    conn.on("error", () => { resolve(true); });
  });
}

export async function checkPorts(ports: { web: number; emailWorker: number; wsDo: number }): Promise<void> {
  const checks = [
    { name: "web", port: ports.web },
    { name: "email-worker", port: ports.emailWorker },
    { name: "ws-do", port: ports.wsDo },
  ];

  for (const { name, port } of checks) {
    const available = await checkPort(port);
    if (!available) {
      console.error(`Error: port ${port} (${name}) is already in use.`);
      console.error(`Use --port-web, --port-email, --port-ws to specify alternative ports.`);
      process.exit(1);
    }
  }
}

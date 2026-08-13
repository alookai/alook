import { createConnection } from "net";

export function checkNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 9)) {
    console.error(`Error: Node.js >= 20.9 required (found ${process.versions.node})`);
    process.exit(1);
  }
}

export async function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ port, host: "127.0.0.1" });
    conn.on("connect", () => { conn.destroy(); resolve(false); });
    conn.on("error", () => { resolve(true); });
  });
}

export async function checkPorts(ports: { web: number; emailWorker: number; wsDo: number; wakeWorker: number }): Promise<void> {
  const checks = [
    { name: "web", port: ports.web },
    { name: "email-worker", port: ports.emailWorker },
    { name: "ws-do", port: ports.wsDo },
    { name: "wake-worker", port: ports.wakeWorker },
  ];

  for (const { name, port } of checks) {
    const available = await checkPort(port);
    if (!available) {
      console.error(`Error: port ${port} (${name}) is already in use.`);
      console.error(`Use --port-web, --port-email, --port-ws, and --port-wake to specify alternative ports.`);
      process.exit(1);
    }
  }
}

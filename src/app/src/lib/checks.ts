import { createConnection } from "net";
import { SERVICE_NAMES, type ServicePortProfile } from "./constants.js";

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

export function validateServicePortProfile(profile: ServicePortProfile): void {
  const seen = new Map<number, string>();
  for (const name of SERVICE_NAMES) {
    for (const kind of ["business", "inspector"] as const) {
      const port = profile[name][kind];
      const label = `${name}.${kind}`;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid ${label} port ${String(port)}; choose a different Web/business port`);
      }
      const duplicate = seen.get(port);
      if (duplicate) {
        throw new Error(`port ${port} is assigned to both ${duplicate} and ${label}; choose a different Web/business port`);
      }
      seen.set(port, label);
    }
  }
}

export async function checkPorts(profile: ServicePortProfile): Promise<void> {
  validateServicePortProfile(profile);
  const checks = SERVICE_NAMES.flatMap((name) => [
    { name, kind: "business" as const, port: profile[name].business },
    { name, kind: "inspector" as const, port: profile[name].inspector },
  ]);

  for (const { name, kind, port } of checks) {
    const available = await checkPort(port);
    if (!available) {
      throw new Error(
        `port ${port} (${name} ${kind}) is already in use.\n` +
        "Run 'npx @alook/app stop' before retrying, or choose different business ports.",
      );
    }
  }
}

import { createRequire } from "module";

const requireFromHere = createRequire(import.meta.url);
const PACKAGE_JSON_CANDIDATES = ["../package.json", "../../package.json"] as const;

export function readDaemonVersion(): string {
  for (const candidate of PACKAGE_JSON_CANDIDATES) {
    try {
      const pkg = requireFromHere(candidate) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      continue;
    }
  }
  return "";
}

import { createRequire } from "node:module";
import { realpathSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCommandOnPath } from "./probe.js";

function installationLocations(): readonly string[] {
  const bases = [import.meta.url, join(process.cwd(), "__alook_sdk_loader__.cjs")];
  for (const binary of [process.execPath, resolveCommandOnPath("npm")]) {
    if (!binary) continue;
    bases.push(binary);
    try {
      bases.push(realpathSync(binary));
    } catch { continue; }
  }
  for (const executable of [process.execPath, realpathSync(process.execPath)]) {
    const directory = dirname(executable);
    bases.push(join(directory, "__alook_sdk_loader__.cjs"), join(directory, "..", "lib", "__alook_sdk_loader__.cjs"));
  }
  const prefix = process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX;
  if (prefix) bases.push(join(prefix, "__alook_sdk_loader__.cjs"), join(prefix, "lib", "__alook_sdk_loader__.cjs"));
  return [...new Set(bases)];
}

export function resolveOptionalPackage(
  name: string,
  locations: readonly string[] = installationLocations(),
): { entry: string; version?: string } | undefined {
  for (const base of locations) {
    try {
      const entry = createRequire(base).resolve(name);
      let directory = dirname(entry);
      while (true) {
        try {
          const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: string; version?: string };
          if (manifest.name === name) return { entry, version: manifest.version };
        } catch { }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      return { entry };
    } catch { continue; }
  }
  return undefined;
}

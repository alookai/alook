import { createRequire } from "module";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);

function wranglerBin(): string {
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

export function wranglerProcess(args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [wranglerBin(), ...args] };
}

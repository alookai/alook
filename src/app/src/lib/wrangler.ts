import { createRequire } from "module";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);

function wranglerCli(): string {
  return join(dirname(require.resolve("wrangler/package.json")), "wrangler-dist", "cli.js");
}

export function wranglerProcess(args: string[]): { command: string; args: string[] } {
  // Invoke the real CLI process directly. Wrangler's public bin is another
  // Node wrapper that does not forward POSIX signals to its child, so using it
  // as the owned process root would strand workerd descendants during stop.
  return { command: process.execPath, args: ["--no-warnings", wranglerCli(), ...args] };
}

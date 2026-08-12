import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { main } from "../src/cli/index";

export function packageDaemonArgs(argv: string[]): string[] {
  return ["daemon", ...argv];
}

export async function runPackageDaemon(argv = process.argv.slice(2)): Promise<number> {
  process.env.ALOOK_DAEMON_PACKAGE_WRAPPER = "1";
  return main(packageDaemonArgs(argv));
}

let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href;
} catch {
  isMainModule = false;
}

if (isMainModule) {
  runPackageDaemon().then((code) => process.exit(code));
}

import { cpSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SELF_HOSTED_DIR } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function bundledDir(): string {
  const candidate = join(__dirname, "..", "..", "bundled");
  if (existsSync(candidate)) return candidate;
  const npmCandidate = join(__dirname, "..", "bundled");
  if (existsSync(npmCandidate)) return npmCandidate;
  throw new Error("Cannot find bundled directory. Package may be corrupted.");
}

export function isInstalled(): boolean {
  return existsSync(join(SELF_HOSTED_DIR, "web", "wrangler.toml"));
}

export function installBundled(): void {
  const src = bundledDir();
  mkdirSync(SELF_HOSTED_DIR, { recursive: true });
  cpSync(src, SELF_HOSTED_DIR, { recursive: true });
  console.log(`Installed to ${SELF_HOSTED_DIR}`);
}

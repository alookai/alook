import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from "fs";
import { dirname, join, relative } from "path";
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

function bundledFiles(rootDir: string, currentDir = rootDir): string[] {
  return readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(currentDir, entry.name);
    return entry.isDirectory()
      ? bundledFiles(rootDir, path)
      : [relative(rootDir, path)];
  });
}

function isInstalledFile(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isInstalled(sourceDir = bundledDir(), installDir = SELF_HOSTED_DIR): boolean {
  return getMissingInstallFiles(sourceDir, installDir).length === 0;
}

export function getMissingInstallFiles(
  sourceDir = bundledDir(),
  installDir = SELF_HOSTED_DIR,
): string[] {
  return bundledFiles(sourceDir)
    .filter((file) => !isInstalledFile(join(installDir, file)))
    .sort();
}

export function assertInstallationComplete(
  sourceDir = bundledDir(),
  installDir = SELF_HOSTED_DIR,
): void {
  const missingFiles = getMissingInstallFiles(sourceDir, installDir);
  if (missingFiles.length === 0) return;

  const preview = missingFiles.slice(0, 10).join(", ");
  const remainder = missingFiles.length > 10
    ? `, and ${missingFiles.length - 10} more`
    : "";
  throw new Error(
    `Alook installation is incomplete after installing bundled assets. Missing required files: ${preview}${remainder}. Reinstall @alook/app and try again.`,
  );
}

export function installBundled(): void {
  const src = bundledDir();
  mkdirSync(SELF_HOSTED_DIR, { recursive: true });
  cpSync(src, SELF_HOSTED_DIR, { recursive: true });
  console.log(`Installed to ${SELF_HOSTED_DIR}`);
}

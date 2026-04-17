import { spawnSync } from "child_process";
import { isDev } from "./env.js";
import { getCurrentVersion } from "./version.js";

const PACKAGE = "@alook/cli";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;
const FETCH_TIMEOUT_MS = 3000;

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface EnsureInstalledOptions {
  skip?: boolean;
}

export interface EnsureInstalledDeps {
  fetchLatest?: () => Promise<string | null>;
  runInstall?: (pm: PackageManager) => boolean;
  getCurrent?: () => string;
  isNpxFn?: () => boolean;
  isDevFn?: () => boolean;
  log?: (msg: string) => void;
}

export type InstallAction = "none" | "installed" | "updated" | "failed";

export interface EnsureInstalledResult {
  skipped: boolean;
  action: InstallAction;
  current: string;
  latest: string | null;
  pm: PackageManager;
}

export async function fetchLatestVersion(): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [cMaj = 0, cMin = 0, cPatch = 0] = parse(current);
  const [lMaj = 0, lMin = 0, lPatch = 0] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

export function isNpx(): boolean {
  return (
    process.env.npm_command === "exec" ||
    !!process.env.npm_execpath?.includes("npx-cli")
  );
}

export function detectPackageManager(): PackageManager {
  const ua = process.env.npm_config_user_agent || "";
  if (ua.startsWith("pnpm/")) return "pnpm";
  if (ua.startsWith("yarn/")) return "yarn";
  return "npm";
}

export function installArgs(pm: PackageManager): [string, string[]] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", ["add", "-g", PACKAGE]];
    case "yarn":
      return ["yarn", ["global", "add", PACKAGE]];
    case "npm":
      return ["npm", ["install", "-g", `${PACKAGE}@latest`]];
  }
}

export function installCmdString(pm: PackageManager): string {
  const [bin, args] = installArgs(pm);
  return `${bin} ${args.join(" ")}`;
}

export function runInstall(pm: PackageManager): boolean {
  const [bin, args] = installArgs(pm);
  const result = spawnSync(bin, args, { stdio: "inherit" });
  return result.status === 0;
}

export async function ensureInstalled(
  opts: EnsureInstalledOptions = {},
  deps: EnsureInstalledDeps = {},
): Promise<EnsureInstalledResult> {
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
  const runInst = deps.runInstall ?? runInstall;
  const getCurrent = deps.getCurrent ?? getCurrentVersion;
  const isNpxFn = deps.isNpxFn ?? isNpx;
  const isDevFn = deps.isDevFn ?? isDev;
  const log = deps.log ?? ((m) => console.log(m));

  const current = getCurrent();
  const pm = detectPackageManager();

  if (isDevFn() || opts.skip) {
    return { skipped: true, action: "none", current, latest: null, pm };
  }

  const latest = await fetchLatest();
  if (!latest) {
    return { skipped: false, action: "none", current, latest: null, pm };
  }

  const runningViaNpx = isNpxFn();
  const needsInstall = runningViaNpx;
  const needsUpdate = !runningViaNpx && isNewer(current, latest);

  if (!needsInstall && !needsUpdate) {
    log(`\n✓ ${PACKAGE} is up to date (${current})`);
    return { skipped: false, action: "none", current, latest, pm };
  }

  const cmdStr = installCmdString(pm);
  if (needsInstall) {
    log(`\nInstalling ${PACKAGE} globally (${cmdStr})...`);
  } else {
    log(`\nUpdating ${PACKAGE} ${current} → ${latest} (${cmdStr})...`);
  }

  const ok = runInst(pm);
  if (!ok) {
    log(
      `\nCould not ${needsInstall ? "install" : "update"} ${PACKAGE} automatically.`,
    );
    log(`Install it manually: ${cmdStr}`);
    return { skipped: false, action: "failed", current, latest, pm };
  }

  log(`✓ ${needsInstall ? "Installed" : "Updated"} ${PACKAGE} ${latest}`);
  return {
    skipped: false,
    action: needsInstall ? "installed" : "updated",
    current,
    latest,
    pm,
  };
}

#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const WORKSPACE_DIRS = ["src/shared", "src/cli", "src/app", "src/web", "src/email-worker", "src/ws-do", "src/desktop"];
const DEPLOY_TRIGGER_DIRS = ["src/web", "src/email-worker", "src/ws-do"];

function readPkg(dir) {
  const p = join(ROOT, dir, "package.json");
  return { path: p, pkg: JSON.parse(readFileSync(p, "utf8")) };
}

function writePkg(path, pkg) {
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
}

function bumpSemver(current, type) {
  const base = current.split("-")[0];
  const [major, minor, patch] = base.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const args = process.argv.slice(2);
const updateMinCli = args.includes("--min-cli");
const includeDesktop = args.includes("--desktop");
const includeMobile = args.includes("--mobile");
const filtered = args.filter((a) => !a.startsWith("--"));
const arg = filtered[0];

if (!arg) {
  console.error("Usage: pnpm bump <version|patch|minor|major> [flags]");
  console.error("  pnpm bump patch");
  console.error("  pnpm bump patch --desktop        # trigger desktop build");
  console.error("  pnpm bump patch --mobile         # trigger mobile build");
  console.error("  pnpm bump patch --desktop --mobile  # trigger both");
  console.error("  pnpm bump patch --min-cli        # also update MIN_CLI_VERSION");
  process.exit(1);
}

const BUMP_TYPES = ["patch", "minor", "major"];
let version;

if (BUMP_TYPES.includes(arg)) {
  const { pkg } = readPkg(WORKSPACE_DIRS[0]);
  version = bumpSemver(pkg.version, arg);
} else {
  version = arg.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`Invalid version: ${arg}`);
    process.exit(1);
  }
}

console.log(`\n📦 Bumping all packages to v${version}\n`);

const files = [];

for (const dir of WORKSPACE_DIRS) {
  const { path, pkg } = readPkg(dir);
  const old = pkg.version;
  pkg.version = version;
  writePkg(path, pkg);
  files.push(path);
  console.log(`  ${pkg.name}: ${old} → ${version}`);
}

// CF Workers deploy triggers (always)
for (const dir of DEPLOY_TRIGGER_DIRS) {
  const triggerPath = join(ROOT, dir, ".deploy-version");
  writeFileSync(triggerPath, version + "\n");
  files.push(triggerPath);
}
console.log(`  CF deploy triggers updated`);

// Sync tauri.conf.json version (always)
const tauriConfPath = join(ROOT, "src/desktop/src-tauri/tauri.conf.json");
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
const oldTauriVersion = tauriConf.version;
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");
files.push(tauriConfPath);
console.log(`  tauri.conf.json: ${oldTauriVersion} → ${version}`);

// Sync Cargo.toml version (always)
const cargoTomlPath = join(ROOT, "src/desktop/src-tauri/Cargo.toml");
let cargoToml = readFileSync(cargoTomlPath, "utf8");
const oldCargoMatch = cargoToml.match(/^version = "([^"]+)"/m);
const oldCargoVersion = oldCargoMatch ? oldCargoMatch[1] : "unknown";
cargoToml = cargoToml.replace(/^version = "[^"]+"/m, `version = "${version}"`);
writeFileSync(cargoTomlPath, cargoToml);
files.push(cargoTomlPath);
console.log(`  Cargo.toml: ${oldCargoVersion} → ${version}`);

// Sync Cargo.lock version for alook-desktop (always)
const cargoLockPath = join(ROOT, "src/desktop/src-tauri/Cargo.lock");
let cargoLock = readFileSync(cargoLockPath, "utf8");
cargoLock = cargoLock.replace(
  /(name = "alook-desktop"\nversion = ")[^"]+"/,
  `$1${version}"`,
);
writeFileSync(cargoLockPath, cargoLock);
files.push(cargoLockPath);
console.log(`  Cargo.lock: alook-desktop → ${version}`);

// Desktop deploy trigger (only with --desktop)
if (includeDesktop) {
  const triggerPath = join(ROOT, "src/desktop/.deploy-version");
  writeFileSync(triggerPath, version + "\n");
  files.push(triggerPath);
  console.log(`  Desktop deploy trigger written`);
}

// Mobile deploy trigger (only with --mobile)
if (includeMobile) {
  const triggerPath = join(ROOT, "src/desktop/.deploy-version-mobile");
  writeFileSync(triggerPath, version + "\n");
  files.push(triggerPath);
  console.log(`  Mobile deploy trigger written`);
}

if (updateMinCli) {
  const tomlPath = join(ROOT, "src/web/wrangler.toml");
  let toml = readFileSync(tomlPath, "utf8");
  const oldMatch = toml.match(/MIN_CLI_VERSION\s*=\s*"([^"]+)"/);
  const oldMinCli = oldMatch ? oldMatch[1] : "unknown";
  toml = toml.replace(/MIN_CLI_VERSION\s*=\s*"[^"]+"/, `MIN_CLI_VERSION = "${version}"`);
  writeFileSync(tomlPath, toml);
  files.push(tomlPath);
  console.log(`  MIN_CLI_VERSION: ${oldMinCli} → ${version} (wrangler.toml)`);
}

const gitFiles = files.map((f) => f.replace(ROOT + "/", ""));
execSync(`git add ${gitFiles.join(" ")}`, { cwd: ROOT, stdio: "inherit" });
execSync(`git commit -m "release: v${version}"`, { cwd: ROOT, stdio: "inherit" });

console.log(`\n✅ Committed: v${version}`);
console.log(`\n👉 Next steps:`);
console.log(`   git push origin main`);
console.log(`   # CI will auto-tag and trigger:`);
console.log(`   #   - CF Workers deploy (always)`);
if (includeDesktop) console.log(`   #   - Desktop build (macOS/Linux/Windows)`);
if (includeMobile) console.log(`   #   - Mobile build (iOS/Android)`);
if (!includeDesktop && !includeMobile) console.log(`   #   - No desktop/mobile builds (add --desktop or --mobile to include)`);
console.log();

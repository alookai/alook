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
  const [major, minor, patch] = current.split(".").map(Number);
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

for (const dir of DEPLOY_TRIGGER_DIRS) {
  const triggerPath = join(ROOT, dir, ".deploy-version");
  writeFileSync(triggerPath, version + "\n");
  files.push(triggerPath);
}
console.log(`  CF deploy triggers updated`);

// Sync tauri.conf.json version
const tauriConfPath = join(ROOT, "src/desktop/src-tauri/tauri.conf.json");
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
const oldTauriVersion = tauriConf.version;
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");
files.push(tauriConfPath);
console.log(`  tauri.conf.json: ${oldTauriVersion} → ${version}`);

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

const markers = [];
if (includeDesktop) markers.push("[desktop]");
if (includeMobile) markers.push("[mobile]");
const markerSuffix = markers.length ? " " + markers.join(" ") : "";
execSync(`git commit -m "release: v${version}${markerSuffix}"`, { cwd: ROOT, stdio: "inherit" });

console.log(`\n✅ Committed: v${version}${markerSuffix}`);
console.log(`\n👉 Next steps:`);
console.log(`   git push origin main`);
console.log(`   # CI will auto-tag and trigger:`);
console.log(`   #   - CF Workers deploy (always)`);
if (includeDesktop) console.log(`   #   - Desktop build (macOS/Linux/Windows)`);
if (includeMobile) console.log(`   #   - Mobile build (iOS/Android)`);
if (!includeDesktop && !includeMobile) console.log(`   #   - No desktop/mobile builds (add --desktop or --mobile to include)`);
console.log();

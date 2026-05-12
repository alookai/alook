#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const WORKSPACE_DIRS = ["src/shared", "src/cli", "src/app", "src/web", "src/email-worker", "src/ws-do"];

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
const filtered = args.filter((a) => a !== "--min-cli");
const arg = filtered[0];

if (!arg) {
  console.error("Usage: pnpm bump <version|patch|minor|major> [--min-cli]");
  console.error("  pnpm bump 0.0.11");
  console.error("  pnpm bump v0.0.11");
  console.error("  pnpm bump patch");
  console.error("  pnpm bump patch --min-cli   # also update MIN_CLI_VERSION in wrangler.toml");
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

console.log(`\n✅ Committed: release: v${version}`);
console.log(`\n👉 Next steps:`);
console.log(`   git push origin main`);
console.log(`   # CI will auto-publish @alook/cli and trigger CF deployments\n`);

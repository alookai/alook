#!/usr/bin/env node
/**
 * Copy pre-built @alook/cli dist files into app/dist/cli/.
 * Run as part of the app build step so the CLI is bundled
 * directly into @alook/app — no separate npm dependency needed.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const cliRoot = join(appRoot, "..", "cli");
const cliDist = join(cliRoot, "dist");
const targetDir = join(appRoot, "dist", "cli");

const REQUIRED_FILES = ["index.js", "session-runner.js", "meeting-runner.js"];

if (!REQUIRED_FILES.every((f) => existsSync(join(cliDist, f)))) {
  console.log("[bundle-cli] CLI dist not found, building...");
  execSync("pnpm run build", { cwd: cliRoot, stdio: "inherit" });
}

mkdirSync(targetDir, { recursive: true });
for (const file of REQUIRED_FILES) {
  cpSync(join(cliDist, file), join(targetDir, file));
}

console.log(`[bundle-cli] Copied ${REQUIRED_FILES.join(", ")} → dist/cli/`);

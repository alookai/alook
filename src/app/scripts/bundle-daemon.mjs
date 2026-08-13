#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const daemonRoot = join(appRoot, "..", "daemon");
const source = join(daemonRoot, "dist", "cli", "index.js");
const targetDir = join(appRoot, "dist", "daemon");
const target = join(targetDir, "index.js");

execSync("pnpm run build", { cwd: daemonRoot, stdio: "inherit" });
if (!existsSync(source)) throw new Error("@alook/daemon build did not produce dist/cli/index.js");

rmSync(join(appRoot, "dist", "cli"), { recursive: true, force: true });
rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(source, target);
console.log("[bundle-daemon] Copied @alook/daemon dist/cli/index.js → dist/daemon/index.js");

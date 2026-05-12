#!/usr/bin/env node
/**
 * Dev wrapper for @alook/app — run from monorepo root:
 *   pnpm dev:app onboard
 *   pnpm dev:app start
 *   pnpm dev:app stop
 *
 * Dev mode runs all services directly from monorepo source — no bundle needed.
 */
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const appDir = join(root, "src", "app");

const args = process.argv.slice(2);

const child = spawn("bun", ["run", "src/index.ts", ...args], {
  cwd: appDir,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "development", ALOOK_PROJECT_ROOT: root },
});

child.on("exit", (code) => process.exit(code ?? 0));

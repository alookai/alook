#!/usr/bin/env node
/**
 * Agent-facing CLI shim — runs the TS source via tsx (avoids extensionless ESM
 * issue in the compiled dist). For local dev only; a real deployment would use a
 * bundled single-file CLI.
 */
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(__dirname, "../node_modules/.bin/tsx");
const cli = resolve(__dirname, "../src/cli/index.ts");

const result = spawnSync(tsx, [cli, ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});

process.exit(result.status ?? 1);

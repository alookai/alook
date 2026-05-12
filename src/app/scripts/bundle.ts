#!/usr/bin/env bun
/**
 * Bundle script — run in CI before `npm publish` of @alook/app.
 * Builds web (opennextjs-cloudflare), email-worker, and ws-do,
 * then copies artifacts into bundled/.
 */
import { execSync } from "child_process";
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const monoRoot = join(appRoot, "..", "..");
const bundledDir = join(appRoot, "bundled");

function run(cmd: string, cwd: string) {
  console.log(`[bundle] ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// Clean
if (existsSync(bundledDir)) rmSync(bundledDir, { recursive: true });

// --- Build Web ---
console.log("\n=== Building Web (opennextjs-cloudflare) ===\n");
const webSrc = join(monoRoot, "src", "web");
run("npx opennextjs-cloudflare build", webSrc);

// Copy .open-next + wrangler.toml + migrations
const webDest = join(bundledDir, "web");
mkdirSync(webDest, { recursive: true });
cpSync(join(webSrc, ".open-next"), join(webDest, ".open-next"), { recursive: true });
cpSync(join(webSrc, "wrangler.toml"), join(webDest, "wrangler.toml"));
cpSync(join(webSrc, "custom-worker.ts"), join(webDest, "custom-worker.ts"));
cpSync(join(webSrc, "migrations"), join(webDest, "migrations"), { recursive: true });

// --- Build Email Worker ---
console.log("\n=== Building Email Worker ===\n");
const emailSrc = join(monoRoot, "src", "email-worker");
const emailDest = join(bundledDir, "email-worker");
mkdirSync(emailDest, { recursive: true });
cpSync(join(emailSrc, "wrangler.toml"), join(emailDest, "wrangler.toml"));
cpSync(join(emailSrc, "src"), join(emailDest, "src"), { recursive: true });
cpSync(join(emailSrc, "package.json"), join(emailDest, "package.json"));
cpSync(join(emailSrc, "tsconfig.json"), join(emailDest, "tsconfig.json"));

// --- Build WS-DO ---
console.log("\n=== Building WS-DO ===\n");
const wsSrc = join(monoRoot, "src", "ws-do");
const wsDest = join(bundledDir, "ws-do");
mkdirSync(wsDest, { recursive: true });
cpSync(join(wsSrc, "src"), join(wsDest, "src"), { recursive: true });
cpSync(join(wsSrc, "package.json"), join(wsDest, "package.json"));
cpSync(join(wsSrc, "tsconfig.json"), join(wsDest, "tsconfig.json"));
cpSync(join(wsSrc, "wrangler.toml"), join(wsDest, "wrangler.toml"));

console.log("\n✓ Bundle complete at:", bundledDir);
console.log("  Contents:", readdirSync(bundledDir).join(", "));

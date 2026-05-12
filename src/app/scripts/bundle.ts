#!/usr/bin/env bun
/**
 * Bundle script — run in CI before `npm publish` of @alook/app.
 * Builds web (opennextjs-cloudflare), email-worker, and ws-do into
 * pre-compiled bundles that can run with `wrangler dev --local` without
 * needing source code or node_modules.
 */
import { execSync } from "child_process";
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
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

run("npx wrangler deploy --dry-run --outdir dist", emailSrc);
cpSync(join(emailSrc, "dist", "index.js"), join(emailDest, "index.js"));

const emailToml = readFileSync(join(emailSrc, "wrangler.toml"), "utf-8");
writeFileSync(
  join(emailDest, "wrangler.toml"),
  emailToml.replace('main = "src/index.ts"', 'main = "index.js"'),
);

// --- Build WS-DO ---
console.log("\n=== Building WS-DO ===\n");
const wsSrc = join(monoRoot, "src", "ws-do");
const wsDest = join(bundledDir, "ws-do");
mkdirSync(wsDest, { recursive: true });

run("npx wrangler deploy --dry-run --outdir dist", wsSrc);
cpSync(join(wsSrc, "dist", "index.js"), join(wsDest, "index.js"));

const wsToml = readFileSync(join(wsSrc, "wrangler.toml"), "utf-8");
writeFileSync(
  join(wsDest, "wrangler.toml"),
  wsToml.replace('main = "src/index.ts"', 'main = "index.js"'),
);

console.log("\n✓ Bundle complete at:", bundledDir);
console.log("  Contents:", readdirSync(bundledDir).join(", "));

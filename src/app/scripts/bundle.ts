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

function rewriteAbsolutePaths(webDest: string): void {
  const handlerDir = join(webDest, ".open-next/server-functions/default/src/web");
  const metaPath = join(handlerDir, "handler.mjs.meta.json");
  const handlerPath = join(handlerDir, "handler.mjs");

  if (!existsSync(metaPath) || !existsSync(handlerPath)) return;

  let meta = readFileSync(metaPath, "utf-8");

  // Wrangler resolves "path" fields relative to the handler file's directory (src/web/).
  // Assets live at .open-next/server-functions/default/node_modules/... which is ../../node_modules/ from src/web/.
  const match = meta.match(/"path":\s*"(\/[^"]*?)\.open-next\/server-functions\/default\/node_modules\//);
  if (!match) return;

  const ciPrefix = match[1] + ".open-next/server-functions/default/node_modules/";
  console.log(`[bundle] Rewriting CI paths (prefix: ${ciPrefix})`);

  meta = meta.replaceAll(ciPrefix, "../../node_modules/");
  writeFileSync(metaPath, meta);

  let handler = readFileSync(handlerPath, "utf-8");
  handler = handler.replaceAll(ciPrefix, "../../node_modules/");
  writeFileSync(handlerPath, handler);
}

// Clean
if (existsSync(bundledDir)) rmSync(bundledDir, { recursive: true });

// --- Build Web ---
console.log("\n=== Building Web (opennextjs-cloudflare) ===\n");
const webSrc = join(monoRoot, "src", "web");

const blogStub = `\
export interface BlogPost { slug: string; title: string; date: string; author: string; excerpt: string; readingTime: string; content: string; }
export function getAllPosts(): BlogPost[] { return []; }
export function getPostBySlug(slug: string): BlogPost | undefined { return undefined; }
`;

// Strip blog content before building the app package
const blogAppDir = join(webSrc, "src", "app", "blog");
const blogLibDir = join(webSrc, "src", "lib", "blog");

const blogPublicDir = join(webSrc, "public", "blog");

console.log("[bundle] Stripping blog content for app-only build...");
rmSync(blogAppDir, { recursive: true });
rmSync(blogLibDir, { recursive: true });
rmSync(blogPublicDir, { recursive: true, force: true });
mkdirSync(blogLibDir, { recursive: true });
writeFileSync(join(blogLibDir, "posts.ts"), blogStub);

try {
  run("npx opennextjs-cloudflare build", webSrc);
} finally {
  console.log("[bundle] Restoring blog source files...");
  try {
    execSync("git checkout -- src/web/src/app/blog/ src/web/src/lib/blog/ src/web/public/blog/", {
      cwd: monoRoot,
      stdio: "inherit",
    });
  } catch (e) {
    console.error("[bundle] WARNING: Failed to restore blog files:", e);
  }
}

const webDest = join(bundledDir, "web");
mkdirSync(webDest, { recursive: true });
cpSync(join(webSrc, ".open-next"), join(webDest, ".open-next"), { recursive: true });
rewriteAbsolutePaths(webDest);
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

#!/usr/bin/env bun
/**
 * Bundle script — run in CI before `npm publish` of @alook/app.
 * Builds web (opennextjs-cloudflare), email-worker, ws-do, and queue-worker into
 * pre-compiled bundles that can run with `wrangler dev --local` without
 * needing source code or node_modules.
 */
import { SELF_HOSTED_SERVICES } from "../src/lib/service-topology.js";
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

if (existsSync(bundledDir)) rmSync(bundledDir, { recursive: true });

console.log("\n=== Building Web (opennextjs-cloudflare) ===\n");
const webSrc = join(monoRoot, "src", "web");
run("node ../../scripts/ci/run-turbo.mjs run @alook/web#build @alook/email-worker#build @alook/ws-do#build @alook/queue-worker#build", appRoot);

const webDest = join(bundledDir, "web");
mkdirSync(webDest, { recursive: true });
cpSync(join(webSrc, ".open-next"), join(webDest, ".open-next"), { recursive: true });
rewriteAbsolutePaths(webDest);
cpSync(join(webSrc, "wrangler.toml"), join(webDest, "wrangler.toml"));
const webPackage = JSON.parse(readFileSync(join(webSrc, "package.json"), "utf8"));
writeFileSync(join(webDest, "package.json"), JSON.stringify({ type: "module", imports: webPackage.imports }, null, 2) + "\n");
cpSync(join(webSrc, "custom-worker.ts"), join(webDest, "custom-worker.ts"));
mkdirSync(join(webDest, "src", "lib"), { recursive: true });
mkdirSync(join(webDest, "src", "lib", "observability"), { recursive: true });
for (const runtimeFile of ["worker-runtime.ts", "public-worker-response.ts", "observability/build.ts", "observability/coverage.ts", "observability/schema.ts", "observability/trace-response.ts"]) {
  cpSync(
    join(webSrc, "src", "lib", runtimeFile),
    join(webDest, "src", "lib", runtimeFile),
  );
}
cpSync(join(webSrc, "migrations"), join(webDest, "migrations"), { recursive: true });

for (const service of SELF_HOSTED_SERVICES) {
  if (service.key === "web") continue;
  console.log(`\n=== Building ${service.label} ===\n`);
  const source = join(monoRoot, "src", service.directory);
  const destination = join(bundledDir, service.directory);
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, "dist", "index.js"), join(destination, "index.js"));
  writeFileSync(
    join(destination, "wrangler.toml"),
    readFileSync(join(source, "wrangler.toml"), "utf8").replace('main = "src/index.ts"', 'main = "index.js"'),
  );
}

console.log("\n✓ Bundle complete at:", bundledDir);
console.log("  Contents:", readdirSync(bundledDir).join(", "));

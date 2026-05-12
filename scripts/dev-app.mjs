#!/usr/bin/env node
/**
 * Dev wrapper for @alook/app — run from monorepo root:
 *   pnpm dev:app onboard
 *   pnpm dev:app start
 *   pnpm dev:app stop
 *
 * Asks whether to re-bundle before running.
 */
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { createInterface } from "readline";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const appDir = join(root, "src", "app");
const bundledDir = join(appDir, "bundled");

const args = process.argv.slice(2);

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

const needsBundle = ["onboard", "start"];

async function main() {
  const command = args[0];

  if (needsBundle.includes(command)) {
    const hasBundled = existsSync(join(bundledDir, "web", "wrangler.toml"));

    if (!hasBundled) {
      console.log("⚠️  No bundled/ directory found. You need to bundle first.\n");
      const answer = await ask("Run bundle now? (Y/n) ");
      if (answer === "n" || answer === "no") {
        console.log("Cannot run without bundled assets. Exiting.");
        process.exit(1);
      }
      console.log("\nBundling... (this may take a few minutes)\n");
      execSync("bun run scripts/bundle.ts", { cwd: appDir, stdio: "inherit" });
    } else {
      const answer = await ask("Re-bundle? (y/N) ");
      if (answer === "y" || answer === "yes") {
        console.log("\nBundling...\n");
        execSync("bun run scripts/bundle.ts", { cwd: appDir, stdio: "inherit" });
      }
    }
  }

  // Run the CLI via bun (no build step needed)
  // Set ALOOK_PROJECT_ROOT so @alook/app and @alook/cli share the same .alook/ dir
  const child = spawn("bun", ["run", "src/index.ts", ...args], {
    cwd: appDir,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development", ALOOK_PROJECT_ROOT: root },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

main();

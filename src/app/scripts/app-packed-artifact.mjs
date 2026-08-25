#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackedArtifact } from "./verify-packed-artifact.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const appRoot = resolve(dirname(scriptPath), "..");

function parseArgs(argv) {
  const result = { skipBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-build") result.skipBuild = true;
    else if (arg === "--output-dir") result.outputDir = argv[++index];
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return result;
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, env: { ...process.env, CI: "true" }, stdio: "inherit" });
}

function digest(path, algorithm, encoding = "hex") {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

export function runAppPackedArtifact(options) {
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  if (!options.skipBuild) {
    run("pnpm", ["run", "bundle"], appRoot);
    run("pnpm", ["run", "build"], appRoot);
  }
  const packed = JSON.parse(execFileSync("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    outputDir,
  ], { cwd: appRoot, encoding: "utf8", env: { ...process.env, CI: "true" } }));
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== "string") {
    throw new Error("npm pack did not return exactly one artifact");
  }
  const tarball = join(outputDir, packed[0].filename);
  if (!existsSync(tarball)) throw new Error(`npm pack artifact missing: ${tarball}`);
  const integrity = `sha512-${digest(tarball, "sha512", "base64")}`;
  if (packed[0].integrity && packed[0].integrity !== integrity) {
    throw new Error("npm pack integrity does not match the exact tarball bytes");
  }
  const verification = verifyPackedArtifact(tarball, {
    scratchRoot: join(outputDir, "artifact-verification"),
  });
  const manifest = {
    package: packed[0].name,
    version: packed[0].version,
    tarball,
    filename: packed[0].filename,
    integrity,
    sha256: digest(tarball, "sha256"),
    verification: {
      positiveWrangler: "passed",
      negativeWrangler: "failed-missing-worker-runtime",
      positiveLog: verification.positiveLog,
      negativeLog: verification.negativeLog,
    },
  };
  const manifestPath = join(outputDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, manifestPath };
}

if (process.argv[1] === scriptPath) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.outputDir) {
      throw new Error("Usage: app-packed-artifact.mjs --output-dir <directory> [--skip-build]");
    }
    console.log(JSON.stringify(runAppPackedArtifact(args), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

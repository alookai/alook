import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);

function wranglerBin() {
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

function runWrangler(webRoot, outdir) {
  return spawnSync(
    process.execPath,
    [wranglerBin(), "deploy", "--dry-run", "--outdir", outdir, "--config", join(webRoot, "wrangler.toml")],
    {
      cwd: webRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
    },
  );
}

function outputOf(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function extractPackage(tarball, destination) {
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", destination], { stdio: "pipe" });
  const packageRoot = join(destination, "package");
  if (!existsSync(join(packageRoot, "package.json"))) {
    throw new Error(`Packed artifact did not extract to ${packageRoot}`);
  }
  return packageRoot;
}

export function verifyExtractedPackage(packageRoot, scratchRoot) {
  const webRoot = join(packageRoot, "bundled", "web");
  const runtimePath = join(webRoot, "src", "lib", "worker-runtime.ts");
  const entryPath = join(webRoot, "custom-worker.ts");
  if (!existsSync(entryPath)) throw new Error(`Packed artifact is missing ${entryPath}`);
  if (!existsSync(runtimePath)) throw new Error(`Packed artifact is missing ${runtimePath}`);

  const negativePackageRoot = join(scratchRoot, "negative", "package");
  cpSync(packageRoot, negativePackageRoot, { recursive: true });
  const negativeRuntime = join(negativePackageRoot, "bundled", "web", "src", "lib", "worker-runtime.ts");
  rmSync(negativeRuntime);

  const negativeOut = join(scratchRoot, "negative-wrangler");
  const negative = runWrangler(join(negativePackageRoot, "bundled", "web"), negativeOut);
  const negativeOutput = outputOf(negative);
  writeFileSync(join(scratchRoot, "negative-wrangler.log"), negativeOutput);
  if (negative.status === 0) {
    throw new Error("0.1.18-shaped negative artifact unexpectedly passed Wrangler dry-run");
  }
  if (!negativeOutput.includes("worker-runtime")) {
    throw new Error(`Negative artifact failed for the wrong reason:\n${negativeOutput}`);
  }

  const positiveOut = join(scratchRoot, "positive-wrangler");
  const positive = runWrangler(webRoot, positiveOut);
  const positiveOutput = outputOf(positive);
  writeFileSync(join(scratchRoot, "positive-wrangler.log"), positiveOutput);
  if (positive.status !== 0) {
    throw new Error(`Packed artifact Wrangler dry-run failed:\n${positiveOutput}`);
  }
  if (!existsSync(positiveOut) || readdirSync(positiveOut).length === 0) {
    throw new Error("Packed artifact Wrangler dry-run produced no output");
  }

  return {
    entryPath,
    runtimePath,
    negativeLog: join(scratchRoot, "negative-wrangler.log"),
    positiveLog: join(scratchRoot, "positive-wrangler.log"),
    positiveOut,
  };
}

export function verifyPackedArtifact(tarball, options = {}) {
  const artifact = resolve(tarball);
  if (!existsSync(artifact)) throw new Error(`Packed artifact not found: ${artifact}`);
  const ownedScratch = !options.scratchRoot;
  const scratchRoot = options.scratchRoot
    ? resolve(options.scratchRoot)
    : mkdtempSync(join(tmpdir(), "alook-app-packed-artifact-"));
  mkdirSync(scratchRoot, { recursive: true });
  let completed = false;

  try {
    const packageRoot = extractPackage(artifact, join(scratchRoot, "extracted"));
    const result = { artifact, scratchRoot, ...verifyExtractedPackage(packageRoot, scratchRoot) };
    completed = true;
    return result;
  } catch (error) {
    if (ownedScratch) {
      console.error(`Packed artifact evidence retained at ${scratchRoot}`);
    }
    throw error;
  } finally {
    if (ownedScratch && completed && process.env.ALOOK_KEEP_PACKAGE_EVIDENCE !== "1") {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === scriptPath) {
  const tarball = process.argv[2];
  if (!tarball) {
    console.error("Usage: node scripts/verify-packed-artifact.mjs <package.tgz> [scratch-dir]");
    process.exitCode = 2;
  } else {
    try {
      const result = verifyPackedArtifact(tarball, { scratchRoot: process.argv[3] });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

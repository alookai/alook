import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = fileURLToPath(new URL("../", import.meta.url));
export const upstream = resolve(here, ".cache/upstream");
export const pin = JSON.parse(readFileSync(new URL("../upstream.json", import.meta.url), "utf8"));

export function run(command, args, cwd = upstream, extraEnv = {}) {
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

export function prepare() {
  if (!existsSync(resolve(upstream, ".git"))) {
    mkdirSync(resolve(here, ".cache"), { recursive: true });
    const localSource = process.env.OPEN_ARTIFACT_SOURCE;
    if (localSource) {
      const revision = execFileSync("git", ["-C", resolve(localSource), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      if (revision !== pin.revision) throw new Error("OPEN_ARTIFACT_SOURCE must match the pinned upstream revision");
      run("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", resolve(localSource), upstream], here);
      run("git", ["remote", "set-url", "origin", pin.repository]);
    } else {
      mkdirSync(upstream, { recursive: true });
      run("git", ["init", "--quiet"]);
      run("git", ["remote", "add", "origin", pin.repository]);
      run("git", ["fetch", "--quiet", "--depth", "1", "origin", pin.revision]);
    }
    run("git", ["checkout", "--quiet", "--detach", pin.revision]);
  }
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim();
  if (revision !== pin.revision) throw new Error("Unexpected Open Artifact checkout revision");
  if (!existsSync(resolve(upstream, "node_modules/.bin/esbuild"))) run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  return upstream;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepare();

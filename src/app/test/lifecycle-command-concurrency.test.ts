import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServicePortProfile } from "../src/lib/constants.js";

const scratch = mkdtempSync(join(tmpdir(), "alook-lifecycle-command-"));
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const fakeBin = join(scratch, "bin");
const supervisor = join(scratch, "service-supervisor.js");
const fakeNpx = join(fakeBin, process.platform === "win32" ? "npx.cmd" : "npx");

async function free(port: number): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}

async function profile(): Promise<ServicePortProfile> {
  for (let base = 31_000 + process.pid % 1_000; base < 59_000; base += 11) {
    const candidate: ServicePortProfile = {
      web: { business: base, inspector: base + 4_019 },
      emailWorker: { business: base + 1, inspector: base + 4_021 },
      wsDo: { business: base + 2, inspector: base + 4_020 },
      wakeWorker: { business: base + 3, inspector: base + 4_022 },
    };
    if ((await Promise.all(Object.values(candidate).flatMap((ports) => [free(ports.business), free(ports.inspector)]))).every(Boolean)) {
      return candidate;
    }
  }
  throw new Error("no isolated lifecycle command port profile available");
}

async function waitForFiles(
  paths: string[],
  children: ChildProcess[],
  diagnostics: Array<{ stdout: string; stderr: string }>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every(existsSync)) return;
    const exited = children.findIndex((child, index) => (
      !existsSync(paths[index]) && (child.exitCode !== null || child.signalCode !== null)
    ));
    if (exited !== -1) {
      const detail = diagnostics[exited];
      throw new Error(
        `lifecycle fixture ${exited} exited ${String(children[exited].exitCode ?? children[exited].signalCode)}` +
        `${detail.stderr ? `\nstderr tail:\n${detail.stderr}` : ""}` +
        `${detail.stdout ? `\nstdout tail:\n${detail.stdout}` : ""}`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(
    `timed out waiting for ${paths.join(", ")}` + diagnostics.map((detail, index) => (
      `\nchild ${index} stderr tail:\n${detail.stderr}\nchild ${index} stdout tail:\n${detail.stdout}`
    )).join(""),
  );
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode === 0) return;
    throw new Error(`lifecycle fixture exited ${String(child.exitCode ?? child.signalCode)}`);
  }
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`lifecycle fixture exited ${String(code ?? signal)}`));
    });
  });
}

beforeAll(() => {
  mkdirSync(fakeBin, { recursive: true });
  execFileSync("bun", ["build", join(appRoot, "src/service-supervisor.ts"), "--outfile", supervisor, "--target", "node", "--format", "esm"], {
    cwd: appRoot,
    stdio: "pipe",
  });
  const fixture = join(appRoot, "test/fixtures/fake-npx-service.mjs");
  if (process.platform === "win32") {
    writeFileSync(fakeNpx, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  } else {
    writeFileSync(fakeNpx, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`);
    chmodSync(fakeNpx, 0o755);
  }
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("command-level lifecycle serialization", () => {
  it("lets exactly one barrier-started command own and spawn four services while the other spawns zero", async () => {
    const ports = await profile();
    const state = join(scratch, "state");
    const barrier = join(scratch, "barrier");
    const teardown = join(scratch, "teardown");
    const spawnLog = join(scratch, "spawns.log");
    const profilePath = join(scratch, "profile.json");
    const results = [join(scratch, "result-a.json"), join(scratch, "result-b.json")];
    mkdirSync(state, { recursive: true });
    writeFileSync(profilePath, JSON.stringify(ports));
    writeFileSync(spawnLog, "");
    const env = {
      ...process.env,
      ALOOK_APP_LIFECYCLE_STALE_MS: "2000",
      ALOOK_APP_SUPERVISOR_ENTRY: supervisor,
      ALOOK_APP_TEST_SPAWN_LOG: spawnLog,
      ALOOK_PROJECT_ROOT: resolve(appRoot, "../.."),
      ALOOK_SELF_HOSTED_DIR: state,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      NODE_ENV: "development",
    };
    const children = results.map((result) => spawn("bun", [join(appRoot, "test/fixtures/lifecycle-command.mjs"), barrier, teardown, result, profilePath], {
      cwd: appRoot,
      env,
      stdio: "pipe",
    }));
    const diagnostics = children.map((child) => {
      const detail = { stdout: "", stderr: "" };
      child.stdout?.on("data", (chunk) => {
        detail.stdout = `${detail.stdout}${chunk.toString()}`.slice(-64 * 1024);
      });
      child.stderr?.on("data", (chunk) => {
        detail.stderr = `${detail.stderr}${chunk.toString()}`.slice(-64 * 1024);
      });
      return detail;
    });
    writeFileSync(barrier, "go\n");

    try {
      await waitForFiles(results, children, diagnostics);
      const values = results.map((path) => JSON.parse(readFileSync(path, "utf8")) as { generationOwned: boolean; outcome: string });
      expect(values.filter((value) => value.generationOwned), JSON.stringify(values)).toHaveLength(1);
      expect(values.filter((value) => !value.generationOwned)).toHaveLength(1);
      expect(readFileSync(spawnLog, "utf8").trim().split("\n")).toHaveLength(4);
    } finally {
      writeFileSync(teardown, "stop\n");
      await Promise.all(children.map(waitForExit));
    }

    const availability = await Promise.all(Object.values(ports).flatMap((value) => [free(value.business), free(value.inspector)]));
    expect(availability.every(Boolean)).toBe(true);
  }, 30_000);
});

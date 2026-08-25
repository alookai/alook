#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const serviceNames = ["web", "emailWorker", "wsDo", "wakeWorker"];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    result[key.slice(2)] = argv[++index];
  }
  return result;
}

let activeChild;
let interruptedSignal;

function throwIfInterrupted(allowDuringInterruption = false) {
  if (interruptedSignal && !allowDuringInterruption) {
    throw new Error(`self-hosted smoke interrupted by ${interruptedSignal}`);
  }
}

async function run(command, args, options) {
  throwIfInterrupted(options.allowDuringInterruption);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer;
    const maxBuffer = 64 * 1024 * 1024;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      writeFileSync(options.log, `${stdout}${stderr}`);
      if (error) reject(error);
      else resolvePromise(stdout);
    };
    const append = (current, chunk) => {
      const next = `${current}${chunk.toString()}`;
      if (Buffer.byteLength(next) > maxBuffer) {
        child.kill("SIGTERM");
        finish(new Error(`${options.label} exceeded its 64 MiB output limit; see ${options.log}`));
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(new Error(`${options.label} timed out; see ${options.log}`));
      } else if (code !== 0) {
        finish(new Error(`${options.label} failed (${String(code ?? signal)}); see ${options.log}`));
      } else {
        finish();
      }
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    }, options.timeout ?? 180_000);
    timer.unref();
  });
}

async function reserveProfile() {
  for (let base = 24_000; base <= 58_000; base += 11) {
    const profile = {
      web: { business: base, inspector: base + 4_019 },
      emailWorker: { business: base + 1, inspector: base + 4_021 },
      wsDo: { business: base + 2, inspector: base + 4_020 },
      wakeWorker: { business: base + 3, inspector: base + 4_022 },
    };
    const ports = serviceNames.flatMap((name) => [profile[name].business, profile[name].inspector]);
    const servers = [];
    try {
      for (const port of ports) {
        const server = createServer();
        await new Promise((resolvePromise, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolvePromise);
        });
        servers.push(server);
      }
      await Promise.all(servers.map((server) => new Promise((resolvePromise) => server.close(resolvePromise))));
      return profile;
    } catch {
      await Promise.all(servers.map((server) => new Promise((resolvePromise) => server.close(resolvePromise))));
    }
  }
  throw new Error("could not reserve an isolated eight-port profile");
}

function allPorts(profile) {
  return serviceNames.flatMap((name) => [profile[name].business, profile[name].inspector]);
}

async function portIsFree(port) {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}

async function requireHealth(profile) {
  for (const name of serviceNames) {
    const path = name === "web" ? "/api/health" : "/health";
    const url = `http://127.0.0.1:${profile[name].business}${path}`;
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() < deadline) {
      throwIfInterrupted();
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.status !== 200) throw new Error(`${name} health returned ${response.status}`);
        lastError = undefined;
        break;
      } catch (error) {
        if (error instanceof Error && /health returned/.test(error.message)) throw error;
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    if (lastError) throw new Error(`${name} health remained unreachable: ${String(lastError)}`);
  }
}

function requireRegistry(stateRoot, profile, previousRunId) {
  const path = join(stateRoot, ".pids.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.version !== 1 || value.phase !== "ready" || typeof value.runId !== "string") {
    throw new Error("installed lifecycle registry is not a ready schema-v1 generation");
  }
  if (value.runId === previousRunId) throw new Error("second lifecycle round reused the first runId");
  for (const name of serviceNames) {
    const entry = value.services?.[name];
    if (!entry || entry.businessPort !== profile[name].business || entry.inspectorPort !== profile[name].inspector) {
      throw new Error(`${name} registry ports do not match the smoke profile`);
    }
    if (typeof entry.authority?.token !== "string" || entry.authority.token.length < 40) {
      throw new Error(`${name} registry is missing private supervisor authority`);
    }
    if (typeof entry.logPath !== "string" || !entry.logPath.endsWith(`${name}.log`)) {
      throw new Error(`${name} registry is missing its exact log path`);
    }
  }
  return value.runId;
}

async function requireBackend(installedRoot, stateRoot, env, logPath) {
  const wrangler = join(installedRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  const persistTo = join(stateRoot, "web", ".wrangler", "state");
  const command = "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user','session','community_server','community_read_state_revision') ORDER BY name; PRAGMA foreign_key_check;";
  const stdout = await run(process.execPath, [
    wrangler,
    "d1",
    "execute",
    "alook-app",
    "--local",
    "--persist-to",
    persistTo,
    "--command",
    command,
    "--json",
  ], { cwd: join(stateRoot, "web"), env, log: logPath, label: "D1 backend query" });
  const payload = JSON.parse(stdout);
  const tables = payload[0]?.results?.map((row) => row.name).sort();
  const expected = ["community_read_state_revision", "community_server", "session", "user"];
  if (JSON.stringify(tables) !== JSON.stringify(expected)) {
    throw new Error(`D1 backend tables mismatch: ${JSON.stringify(tables)}`);
  }
  if (!Array.isArray(payload[1]?.results) || payload[1].results.length !== 0) {
    throw new Error("D1 PRAGMA foreign_key_check returned violations");
  }
}

function cliArgs(profile, command) {
  if (command === "stop") return ["stop"];
  return [
    "onboard",
    "--skip-register",
    "--no-open",
    "--port-web",
    String(profile.web.business),
    "--port-email",
    String(profile.emailWorker.business),
    "--port-ws",
    String(profile.wsDo.business),
    "--port-wake",
    String(profile.wakeWorker.business),
  ];
}

export async function runSelfHostedSmoke(packageSpec, options = {}) {
  if (!packageSpec) throw new Error("missing package spec or tarball");
  const scratch = options.scratchRoot
    ? resolve(options.scratchRoot)
    : mkdtempSync(join(tmpdir(), "alook-app-self-hosted-smoke-"));
  const installRoot = join(scratch, "install");
  const stateRoot = join(scratch, "state");
  const evidenceRoot = join(scratch, "evidence");
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(installRoot, "package.json"), '{"private":true}\n');
  const resolvedSpec = isAbsolute(packageSpec) ? packageSpec : packageSpec.startsWith(".") ? resolve(packageSpec) : packageSpec;
  interruptedSignal = undefined;
  const onSigint = () => {
    interruptedSignal ??= "SIGINT";
    activeChild?.kill("SIGINT");
  };
  const onSigterm = () => {
    interruptedSignal ??= "SIGTERM";
    activeChild?.kill("SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
  try {
    await run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock", "--prefix", installRoot, resolvedSpec], {
      cwd: installRoot,
      env: process.env,
      log: join(evidenceRoot, "npm-install.log"),
      label: "fresh package install",
      timeout: 300_000,
    });
  } catch (error) {
    if (!options.keepInstall) rmSync(installRoot, { recursive: true, force: true });
    throw error;
  }
  const cli = join(installRoot, "node_modules", "@alook", "app", "dist", "index.js");
  if (!existsSync(cli)) throw new Error(`installed app CLI is missing: ${cli}`);
  const profile = await reserveProfile();
  const env = {
    ...process.env,
    ALOOK_SELF_HOSTED_DIR: stateRoot,
    NODE_ENV: "production",
    CI: "true",
  };
  delete env.ALOOK_PROJECT_ROOT;
  let previousRunId;
  let primaryError;
  const rounds = [];

  try {
    for (let round = 1; round <= 2; round += 1) {
      await run(process.execPath, [cli, ...cliArgs(profile, "onboard")], {
        cwd: installRoot,
        env,
        log: join(evidenceRoot, `round-${round}-onboard.log`),
        label: `installed onboard round ${round}`,
        timeout: 180_000,
      });
      await requireHealth(profile);
      const runId = requireRegistry(stateRoot, profile, previousRunId);
      await requireBackend(installRoot, stateRoot, env, join(evidenceRoot, `round-${round}-d1.json`));
      await run(process.execPath, [cli, ...cliArgs(profile, "stop")], {
        cwd: installRoot,
        env,
        log: join(evidenceRoot, `round-${round}-stop.log`),
        label: `installed stop round ${round}`,
        timeout: 60_000,
      });
      if (existsSync(join(stateRoot, ".pids.json"))) throw new Error(`round ${round} retained its registry`);
      const availability = await Promise.all(allPorts(profile).map(portIsFree));
      if (!availability.every(Boolean)) throw new Error(`round ${round} retained a business or inspector port`);
      rounds.push({ round, runId });
      previousRunId = runId;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    let teardownError;
    try {
      await run(process.execPath, [cli, "stop"], {
        cwd: installRoot,
        env,
        log: join(evidenceRoot, "final-stop.log"),
        label: "final installed teardown",
        timeout: 60_000,
        allowDuringInterruption: true,
      });
      const availability = await Promise.all(allPorts(profile).map(portIsFree));
      if (!availability.every(Boolean)) throw new Error("final teardown retained a business or inspector port");
    } catch (error) {
      teardownError = error;
    }
    const summary = { packageSpec: resolvedSpec, profile, rounds, completed: !primaryError && !teardownError };
    writeFileSync(join(evidenceRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    const serviceLogs = join(stateRoot, "logs");
    if (existsSync(serviceLogs)) {
      cpSync(serviceLogs, join(evidenceRoot, "service-logs"), { recursive: true });
    }
    if (!options.keepInstall && !teardownError) {
      rmSync(installRoot, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (primaryError && teardownError) throw new AggregateError([primaryError, teardownError], "smoke and teardown both failed");
    if (primaryError) throw primaryError;
    if (teardownError) throw teardownError;
  }

  return { scratchRoot: scratch, evidenceRoot, profile, rounds };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    activeChild = undefined;
  }
}

if (process.argv[1] === scriptPath) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await runSelfHostedSmoke(args.package, { scratchRoot: args["scratch-dir"] });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { DaemonClient } from "./client.js";
import { type DaemonConfig, loadDaemonConfig, sessionRunnerLogDir } from "./config.js";
import { createHealthServer } from "./health.js";
import { detectVersion } from "./agent/index.js";
import { type Task, type SessionRunnerInput, fromApiTask } from "./types.js";
import { loadCLIConfigForProfile, saveCLIConfigForProfile } from "../lib/config.js";
import { log } from "../lib/logger.js";
import { cmdPrefix } from "../lib/env.js";
import { acquireDaemonPid, releaseDaemonPid } from "./pidfile.js";
import { handleCliUpdate, isUpdating, readUpdateMarker, clearUpdateMarker } from "./update-handler.js";
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, statSync, unlinkSync } from "fs";
import { execSync, spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const _dir = dirname(fileURLToPath(import.meta.url));
const sessionRunnerPath = existsSync(join(_dir, "session-runner.js"))
  ? join(_dir, "session-runner.js")
  : join(_dir, "session-runner.ts");

interface WorkspaceState {
  workspaceId: string;
  token: string;
  runtimeIds: string[];
}

interface RuntimeData {
  id: string;
  workspaceId: string;
  provider: string;
}

function isCommandAvailable(cmd: string): boolean {
  try {
    const check = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const MAX_SESSION_RUNNER_LOGS = 50;

export function pruneSessionRunnerLogs(): void {
  const logDir = sessionRunnerLogDir();
  let entries: string[];
  try {
    entries = readdirSync(logDir).filter((f) => f.endsWith(".log"));
  } catch {
    return;
  }
  if (entries.length <= MAX_SESSION_RUNNER_LOGS) return;

  const withMtime = entries.map((name) => {
    const full = join(logDir, name);
    try {
      return { name, mtime: statSync(full).mtimeMs };
    } catch {
      return { name, mtime: 0 };
    }
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);

  for (const entry of withMtime.slice(MAX_SESSION_RUNNER_LOGS)) {
    try {
      unlinkSync(join(logDir, entry.name));
    } catch {
      // best-effort
    }
  }
}

export async function startDaemon(
  profile?: string,
  serverUrl?: string,
): Promise<void> {
  pruneSessionRunnerLogs();

  if (!acquireDaemonPid(profile)) {
    process.exit(1);
  }

  // Safety net: no matter how the process terminates (normal exit, early
  // process.exit, shutdown timeout kick, uncaughtException), release the
  // pidfile. `releaseDaemonPid` only deletes when the file still points at us,
  // so a newer daemon's pidfile is safe.
  process.once("exit", () => releaseDaemonPid(profile));
  const bailOnUnexpected = (label: string, err: unknown) => {
    log.error(`${label} — shutting down`, err);
    releaseDaemonPid(profile);
    process.exit(1);
  };
  process.once("uncaughtException", (err) =>
    bailOnUnexpected("uncaughtException", err),
  );
  process.once("unhandledRejection", (err) =>
    bailOnUnexpected("unhandledRejection", err),
  );

  const config = loadDaemonConfig(profile);
  if (serverUrl) config.serverURL = serverUrl;

  const marker = readUpdateMarker(profile);
  if (marker && marker === config.cliVersion) {
    clearUpdateMarker(profile);
    log.info(`Cleared update marker — now running v${config.cliVersion}`);
  }

  const cliConfig = loadCLIConfigForProfile(profile);

  const workspaces = cliConfig.watched_workspaces || [];
  if (workspaces.length === 0) {
    log.error("No watched workspaces configured.");
    process.exit(1);
    return;
  }

  // Validate: each workspace must have its own token
  const hasPerWorkspaceTokens = workspaces.every((ws) => !!ws.token);
  if (!hasPerWorkspaceTokens) {
    log.error(
      `Config uses old format. Run '${cmdPrefix()} register --token <token>' for each workspace to upgrade.`,
    );
    process.exit(1);
    return;
  }

  // Use server_url from first workspace's config if available
  if (cliConfig.server_url) config.serverURL = cliConfig.server_url;

  const client = new DaemonClient(config.serverURL);
  const health = createHealthServer();

  const providers: { type: string; path: string; version: string }[] = [];
  for (const [type, path] of [
    ["claude", config.claudePath],
    ["codex", config.codexPath],
    ["opencode", config.opencodePath],
  ] as const) {
    if (isCommandAvailable(path)) {
      const version = await detectVersion(path);
      providers.push({ type, path, version });
    }
  }

  if (providers.length === 0) {
    log.error("No agent CLI tools found on PATH.");
    process.exit(1);
    return;
  }

  log.info(
    `Detected providers: ${providers.map((p) => `${p.type}@${p.version}`).join(", ")}`,
  );

  const workspaceStates: WorkspaceState[] = [];
  const runtimeIndex = new Map<string, RuntimeData>();

  for (const ws of workspaces) {
    const runtimes = providers.map((p) => ({
      name: config.runtimeName || `${p.type} (${config.deviceName})`,
      type: p.type,
      version: p.version,
    }));

    log.info(`Registering workspace ${ws.id} (${ws.name ?? "unnamed"}) with ${runtimes.length} runtime(s)...`);
    let resp;
    try {
      resp = await client.register(ws.token, {
        workspace_id: ws.id,
        daemon_id: config.daemonId,
        device_name: config.deviceName,
        cli_version: config.cliVersion,
        runtimes,
      });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("HTTP 401")) {
        log.warn(`Workspace ${ws.id} token invalid — removing from config`);
        try {
          const cfg = loadCLIConfigForProfile(profile);
          cfg.watched_workspaces = (cfg.watched_workspaces || []).filter(
            (w) => w.id !== ws.id,
          );
          saveCLIConfigForProfile(profile, cfg);
        } catch {
          // best-effort
        }
      } else {
        log.error(`Failed to register workspace ${ws.id}, skipping`, e);
      }
      continue;
    }
    log.info(`Workspace ${ws.id} registered — ${resp.runtimes.length} runtime(s)`);

    const runtimeIds = resp.runtimes.map((r: { id: string }) => r.id);
    workspaceStates.push({ workspaceId: ws.id, token: ws.token, runtimeIds });

    for (let i = 0; i < runtimeIds.length; i++) {
      runtimeIndex.set(runtimeIds[i], {
        id: runtimeIds[i],
        workspaceId: ws.id,
        provider: providers[i].type,
      });
    }
  }

  if (workspaceStates.length === 0) {
    log.error("No workspaces registered successfully.");
    process.exit(1);
    return;
  }

  const allRuntimeIds = workspaceStates.flatMap((ws) => ws.runtimeIds);
  health.setRuntimeCount(allRuntimeIds.length);
  log.info(
    `Daemon started — ${allRuntimeIds.length} runtime(s) across ${workspaceStates.length} workspace(s)`,
  );

  const activeTasks = new Set<string>();

  // Seed known agent IDs from config so we only write on genuinely new ones
  const knownAgentIds = new Set<string>(
    workspaces.flatMap((ws) => ws.agent_ids ?? []),
  );

  function syncAgentId(agentId: string, workspaceId: string): void {
    if (knownAgentIds.has(agentId)) return;
    knownAgentIds.add(agentId);
    try {
      const cfg = loadCLIConfigForProfile(profile);
      const ws = cfg.watched_workspaces?.find((w) => w.id === workspaceId);
      if (!ws) return;
      if (!ws.agent_ids) ws.agent_ids = [];
      if (!ws.agent_ids.includes(agentId)) {
        ws.agent_ids.push(agentId);
        saveCLIConfigForProfile(profile, cfg);
      }
    } catch {
      // Non-fatal — config sync is best-effort
    }
  }

  function evictWorkspace(workspaceId: string): void {
    const idx = workspaceStates.findIndex((ws) => ws.workspaceId === workspaceId);
    if (idx === -1) return;

    const ws = workspaceStates[idx];
    for (const rid of ws.runtimeIds) {
      runtimeIndex.delete(rid);
    }
    workspaceStates.splice(idx, 1);

    health.setRuntimeCount(
      workspaceStates.reduce((sum, w) => sum + w.runtimeIds.length, 0),
    );

    try {
      const cfg = loadCLIConfigForProfile(profile);
      cfg.watched_workspaces = (cfg.watched_workspaces || []).filter(
        (w) => w.id !== workspaceId,
      );
      saveCLIConfigForProfile(profile, cfg);
    } catch {
      // Best-effort — config write failure must not block eviction
    }

    log.info(`Workspace ${workspaceId} evicted — runtimes removed server-side`);
  }

  // Staggered per-workspace polling
  const pollCycle = async () => {
    let remaining = config.maxConcurrentTasks - activeTasks.size;
    if (remaining <= 0) return;

    const N = workspaceStates.length;
    const staggerMs = N > 1 ? Math.floor(config.pollInterval / N) : 0;
    const evictedIds: string[] = [];

    for (let i = 0; i < N; i++) {
      if (remaining <= 0) break;
      const ws = workspaceStates[i];

      if (i > 0 && staggerMs > 0) {
        await new Promise((r) => setTimeout(r, staggerMs));
      }

      try {
        const { tasks: apiTasks, evicted, pending_update } = await client.poll(
          ws.token,
          config.daemonId,
          remaining,
          config.cliVersion,
        );

        if (evicted) {
          evictedIds.push(ws.workspaceId);
          continue;
        }

        if (pending_update && !isUpdating() && pending_update.version !== config.cliVersion) {
          handleCliUpdate(pending_update.version, () => requestRestart(), profile);
        }

        for (const apiTask of apiTasks) {
          const task = fromApiTask(apiTask);
          syncAgentId(task.agentId, ws.workspaceId);
          activeTasks.add(task.id);
          remaining--;
          handleTask(client, config, runtimeIndex, task, ws.token, activeTasks)
            .catch((e) => {
              log.error("Task error", e);
              activeTasks.delete(task.id);
            });
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("HTTP 401")) {
          evictedIds.push(ws.workspaceId);
        } else {
          log.debug("Poll error", e);
        }
      }
    }

    for (const id of evictedIds) {
      evictWorkspace(id);
    }

    if (workspaceStates.length === 0) {
      log.info("All workspaces evicted — shutting down");
      shutdown();
    }
  };

  const pollTimer = setInterval(pollCycle, config.pollInterval);

  let shuttingDown = false;
  let restartRequested = false;

  const requestRestart = () => {
    restartRequested = true;
    shutdown();
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(restartRequested ? "Restarting..." : "Shutting down...");
    clearInterval(pollTimer);

    const shutdownMs = restartRequested ? 30000 : (Number(process.env.ALOOK_SHUTDOWN_TIMEOUT_MS) || 5000);
    const timeout = setTimeout(() => process.exit(1), shutdownMs);

    try {
      for (const ws of workspaceStates) {
        await client.deregister(ws.token, config.daemonId);
      }
    } catch {
      // best-effort deregister
    }

    releaseDaemonPid(profile);
    health.server.close(() => {
      if (restartRequested) {
        const args = ["daemon", "start", "--foreground"];
        if (profile) args.push("--profile", profile);
        if (serverUrl) args.push("--server", serverUrl);
        const child = spawn("alook", args, {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        child.unref();
        log.info(`Spawned new daemon (pid=${child.pid})`);
      }
      clearTimeout(timeout);
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await pollCycle();
}

export function spawnSessionRunner(input: SessionRunnerInput): ChildProcess {
  const logDir = sessionRunnerLogDir();
  mkdirSync(logDir, { recursive: true });

  const logFilePath = join(logDir, `${input.task.id}.log`);
  input.logFilePath = logFilePath;

  const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
  const fd = openSync(logFilePath, "a");

  const child = spawn(process.execPath, [sessionRunnerPath, encoded], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);

  return child;
}

async function handleTask(
  client: DaemonClient,
  config: DaemonConfig,
  runtimeIndex: Map<string, RuntimeData>,
  task: Task,
  token: string,
  activeTasks: Set<string>,
): Promise<void> {
  log.info(`Task ${task.id} claimed agent=${task.agentId}`);

  try {
    await client.startTask(token, task.id);
  } catch (e) {
    await client.failTask(token, task.id, `start failed: ${e}`);
    activeTasks.delete(task.id);
    return;
  }

  // Resolve provider-specific CLI path and model
  const runtimeData = runtimeIndex.get(task.runtimeId);
  if (!runtimeData) {
    await client.failTask(token, task.id, `unknown runtime: ${task.runtimeId}`);
    activeTasks.delete(task.id);
    return;
  }

  const provider = runtimeData.provider;
  const cliPath =
    provider === "claude"
      ? config.claudePath
      : provider === "codex"
        ? config.codexPath
        : config.opencodePath;
  const configModel =
    provider === "claude"
      ? config.claudeModel
      : provider === "codex"
        ? config.codexModel
        : config.opencodeModel;
  const agentModel = task.agent?.runtimeConfig?.model;
  const model = (typeof agentModel === "string" && agentModel) ? agentModel : configModel;

  const input: SessionRunnerInput = {
    task,
    provider,
    cliPath,
    model,
    serverURL: config.serverURL,
    token,
    workspacesRoot: config.workspacesRoot,
    agentTimeout: config.agentTimeout,
  };

  const child = spawnSessionRunner(input);
  child.on("close", () => activeTasks.delete(task.id));
  log.info(`Task ${task.id} dispatched to session-runner (pid=${child.pid})`);
}

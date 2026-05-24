import { DaemonClient } from "./client.js";
import { type DaemonConfig, loadDaemonConfig, sessionRunnerLogDir, daemonLogFilePath } from "./config.js";
import { createHealthServer } from "./health.js";
import { detectVersion } from "./agent/index.js";
import { type Task, type SessionRunnerInput, fromApiTask } from "./types.js";
import { type MarkerData, writeMarkerFile } from "./session-runner.js";
import { loadCLIConfigForProfile, saveCLIConfigForProfile } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";
import { DaemonWsClient } from "./ws-client.js";
import type { DaemonPushMessage } from "@alook/shared";

const log = createLogger({ module: "daemon" });
import { cmdPrefix } from "../lib/env.js";
import { acquireDaemonPid, releaseDaemonPid } from "./pidfile.js";
import { handleCliUpdate, isUpdating, readUpdateMarker, clearUpdateMarker } from "./update-handler.js";
import { findRunningPidByTaskId, findRunningEntryByContextKey, updateEntry } from "./execenv/timeline.js";
import {
  writeKillIntent,
  acquireSteeringLock,
  releaseSteeringLock,
  cleanupStaleIntents,
} from "./execenv/steering.js";
import { TASK_TYPES } from "@alook/shared";
import { readDirectoryTree, readFileContent, validatePath } from "./workspace-files.js";
import { startSkillScanner, stopSkillScanner } from "./skill-scanner.js";
import { resolveLoginShellEnv } from "../lib/shell-env.js";
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, statSync, unlinkSync } from "fs";
import { readdir, readFile, unlink, stat as fsStat } from "fs/promises";
import { execSync, spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const _dir = dirname(fileURLToPath(import.meta.url));
const sessionRunnerPath = existsSync(join(_dir, "session-runner.js"))
  ? join(_dir, "session-runner.js")
  : join(_dir, "session-runner.ts");
const meetingRunnerPath = existsSync(join(_dir, "meeting-runner.js"))
  ? join(_dir, "meeting-runner.js")
  : join(_dir, "meeting-runner.ts");

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

const MAX_SESSION_RUNNER_LOGS = 500;

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

export function isClientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const match = error.message.match(/^HTTP (\d+):/);
  if (!match) return false;
  const status = Number(match[1]);
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

function isValidMarker(data: unknown): data is MarkerData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.taskId !== "string") return false;
  if (typeof d.token !== "string") return false;
  if (typeof d.serverURL !== "string") return false;
  if (typeof d.createdAt !== "string" || isNaN(new Date(d.createdAt).getTime())) return false;
  if (!d.payload || typeof d.payload !== "object") return false;
  const payload = d.payload as Record<string, unknown>;
  if (d.type === "complete") {
    return typeof payload.output === "string";
  }
  if (d.type === "fail") {
    return typeof payload.error === "string";
  }
  return false;
}

const MARKER_STALE_MS = 24 * 60 * 60 * 1000;
const TMP_STALE_MS = 60 * 60 * 1000;

export async function reconcilePendingCompletions(workspacesRoot: string): Promise<void> {
  const dir = join(workspacesRoot, ".pending_completions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  // Housekeeping: clean up stale .tmp files
  for (const name of entries) {
    if (!name.endsWith(".tmp")) continue;
    try {
      const s = await fsStat(join(dir, name));
      if (Date.now() - s.mtimeMs > TMP_STALE_MS) {
        await unlink(join(dir, name));
      }
    } catch { /* best-effort */ }
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  for (const name of jsonFiles) {
    const filePath = join(dir, name);
    try {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log.warn(`reconcile: malformed marker ${name}, deleting`);
        try { await unlink(filePath); } catch { /* best-effort */ }
        continue;
      }

      if (!isValidMarker(parsed)) {
        log.warn(`reconcile: invalid marker structure ${name}, deleting`);
        try { await unlink(filePath); } catch { /* best-effort */ }
        continue;
      }

      const marker = parsed;
      const age = Date.now() - new Date(marker.createdAt).getTime();
      if (age > MARKER_STALE_MS) {
        log.warn(`reconcile: stale marker ${name} (${Math.round(age / 3600000)}h old), deleting`);
        try { await unlink(filePath); } catch { /* best-effort */ }
        continue;
      }

      const client = new DaemonClient(marker.serverURL);
      try {
        if (marker.type === "complete") {
          await client.completeTask(marker.token, marker.taskId, marker.payload);
        } else {
          await client.failTask(marker.token, marker.taskId, marker.payload.error);
        }
        try { await unlink(filePath); } catch (delErr) {
          log.warn(`reconcile: delivered marker ${name} but failed to delete: ${delErr}`);
        }
      } catch (deliverErr) {
        if (isClientError(deliverErr)) {
          try { await unlink(filePath); } catch { /* best-effort */ }
        } else {
          log.debug(`reconcile: delivery failed for ${name}, will retry next cycle`);
        }
      }
    } catch (e) {
      log.debug(`reconcile: error processing ${name}`, e);
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
  if (marker) {
    clearUpdateMarker(profile);
    if (marker === config.cliVersion) {
      log.info(`Cleared update marker — now running v${config.cliVersion}`);
    } else {
      log.info(`Cleared stale update marker (was v${marker}, running v${config.cliVersion}) — update will be retried`);
    }
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
        workspaces_root: config.workspacesRoot,
        runtimes,
      });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("HTTP 401")) {
        log.warn(`Workspace ${ws.id} token invalid — skipping (run '${cmdPrefix()} register --token <token>' to fix)`);
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

    log.info(`Workspace ${workspaceId} deleted server-side — removed from config`);
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
        const { tasks: apiTasks, evicted, pending_update, pending_rescan, file_requests, meetings } = await client.poll(
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

        if (pending_rescan) {
          log.info("Rescan requested — restarting daemon to re-detect runtimes");
          for (const id of evictedIds) {
            evictWorkspace(id);
          }
          requestRestart();
          return;
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

        // Handle workspace file browse requests
        if (file_requests) {
          for (const req of file_requests) {
            handleFileRequest(client, config, ws.workspaceId, req, ws.token)
              .catch((e) => log.debug("File request error", e));
          }
        }


        // Spawn meeting bots from merged poll response
        if (meetings) {
          for (const m of meetings) {
            const agentBaseDir = join(config.workspacesRoot, m.workspace_id, m.agent_id, "workdir");
            const timelineDir = join(agentBaseDir, ".context_timeline");
            spawnMeetingRunner({
              meetingId: m.id,
              meetingUrl: m.meeting_url,
              participants: m.participants,
              workspaceId: m.workspace_id,
              callbackUrl: config.serverURL,
              authToken: ws.token,
              agentName: m.agent_name,
              agentId: m.agent_id,
              timelineDir,
              title: m.title,
            });
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("HTTP 401")) {
          log.warn(`Workspace ${ws.workspaceId} poll returned 401 — will retry next cycle`);
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

  let pollTimer = setInterval(pollCycle, config.pollInterval);

  // --- Heartbeat timer (independent of poll and WS state) ---
  const heartbeatPing = () => {
    for (const ws of workspaceStates) {
      client.heartbeat(ws.token, config.daemonId).catch((e) => {
        log.debug("heartbeat failed", { workspaceId: ws.workspaceId, err: String(e) });
      });
    }
  };
  const heartbeatTimer = setInterval(heartbeatPing, config.heartbeatInterval);

  // --- WS Push Channel (primary) + Poll fallback ---
  // Any active machine token suffices — WS auth validates daemon-level access,
  // not per-workspace. Tasks are routed by workspaceId within handleWsPush.
  const firstToken = workspaceStates[0]?.token;

  function updatePollInterval(newInterval: number) {
    clearInterval(pollTimer);
    pollTimer = setInterval(pollCycle, newInterval);
  }

  function handleWsPush(msg: DaemonPushMessage) {
    switch (msg.type) {
      case "daemon.tasks":
        for (const apiTask of msg.tasks) {
          if (activeTasks.size >= config.maxConcurrentTasks) break;
          const task = fromApiTask(apiTask);
          if (activeTasks.has(task.id)) continue;
          const ws = workspaceStates.find((w) => w.workspaceId === task.workspaceId);
          if (!ws) continue;
          syncAgentId(task.agentId, ws.workspaceId);
          activeTasks.add(task.id);
          handleTask(client, config, runtimeIndex, task, ws.token, activeTasks)
            .catch((e) => { log.error("WS task error", e); activeTasks.delete(task.id); });
        }
        break;

      case "daemon.file_requests": {
        const ws = workspaceStates.find((w) => w.workspaceId === msg.workspaceId);
        if (ws) {
          for (const req of msg.requests) {
            handleFileRequest(client, config, ws.workspaceId, req, ws.token)
              .catch((e) => log.debug("WS file request error", e));
          }
        }
        break;
      }


      case "daemon.meetings":
        for (const m of msg.meetings) {
          const ws = workspaceStates.find((w) => w.workspaceId === m.workspace_id);
          if (!ws) continue;
          const agentBaseDir = join(config.workspacesRoot, m.workspace_id, m.agent_id, "workdir");
          const timelineDir = join(agentBaseDir, ".context_timeline");
          spawnMeetingRunner({
            meetingId: m.id,
            meetingUrl: m.meeting_url,
            participants: m.participants,
            workspaceId: m.workspace_id,
            callbackUrl: config.serverURL,
            authToken: ws.token,
            agentName: m.agent_name,
            agentId: m.agent_id,
            timelineDir,
            title: m.title,
          });
        }
        break;

      case "daemon.evict":
        evictWorkspace(msg.workspaceId);
        break;

      case "daemon.update":
        if (!isUpdating() && msg.version !== config.cliVersion) {
          handleCliUpdate(msg.version, () => requestRestart(), profile);
        }
        break;

      case "daemon.rescan":
        log.info("WS rescan requested — restarting daemon");
        requestRestart();
        break;

      case "daemon.kill": {
        const ws = workspaceStates.find((w) => w.workspaceId === msg.workspaceId);
        if (ws) {
          const killTask = fromApiTask({
            id: msg.taskId,
            agent_id: "",
            runtime_id: "",
            conversation_id: "",
            workspace_id: ws.workspaceId,
            prompt: "",
            status: "queued",
            priority: 0,
            dispatched_at: null,
            started_at: null,
            completed_at: null,
            result: null,
            error: null,
            created_at: new Date().toISOString(),
            type: "kill_task",
            context: { target_task_id: msg.targetTaskId },
            agent: null,
            sender: null,
          });
          activeTasks.add(killTask.id);
          handleTask(client, config, runtimeIndex, killTask, ws.token, activeTasks)
            .catch((e) => { log.error("WS kill task error", e); activeTasks.delete(killTask.id); });
        }
        break;
      }
    }
  }

  const wsClient = firstToken
    ? new DaemonWsClient({
        serverURL: config.serverURL,
        daemonId: config.daemonId,
        machineToken: firstToken,
        onMessage: handleWsPush,
        onConnected: () => {
          log.info("WS connected — switching to low-frequency poll");
          updatePollInterval(config.wsPollInterval);
        },
        onDisconnected: () => {
          log.info("WS disconnected — reverting to high-frequency poll");
          updatePollInterval(config.pollInterval);
        },
      })
    : null;

  wsClient?.connect();

  // --- Sweep timer: triggers server-side sweep + local reconciliation ---
  const sweepTick = async () => {
    for (const ws of workspaceStates) {
      client.sweep(ws.token, config.daemonId).catch((e) => {
        log.debug("sweep ping failed", { workspaceId: ws.workspaceId, err: String(e) });
      });
    }
    try {
      await reconcilePendingCompletions(config.workspacesRoot);
    } catch (e) {
      log.debug("reconciliation error", e);
    }
  };
  const sweepTimer = setInterval(sweepTick, config.sweepInterval);

  // --- Skill scanner: scans global + agent skills every 60s ---
  startSkillScanner(client, {
    workspacesRoot: config.workspacesRoot,
    workspaces: workspaces.map((ws) => ({
      workspaceId: ws.id,
      token: ws.token,
      agentIds: ws.agent_ids ?? [],
    })),
    runtimes: providers.map((p) => p.type as "claude" | "codex" | "opencode"),
  }, 60_000);

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
    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);
    stopSkillScanner();
    wsClient?.close();

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
        const entry = process.argv[1];
        const args = [entry, "daemon", "start", "--foreground"];
        if (profile) args.push("--profile", profile);
        if (serverUrl) args.push("--server", serverUrl);
        const logPath = daemonLogFilePath();
        let logFd: number | undefined;
        try {
          mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
          logFd = openSync(logPath, "a", 0o600);
        } catch (e) {
          log.error(`Failed to open daemon log file ${logPath}`, e);
        }
        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: logFd != null ? ["ignore", logFd, logFd] : ["ignore", "ignore", "ignore"],
          env: resolveLoginShellEnv(),
        });
        child.unref();
        if (logFd != null) closeSync(logFd);
        log.info(`Spawned new daemon (pid=${child.pid}), logs: ${logPath}`);
      }
      clearTimeout(timeout);
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // SIGHUP: reload config and register any new workspaces
  process.on("SIGHUP", async () => {
    if (shuttingDown) return;
    log.info("SIGHUP received — reloading config...");
    try {
      const freshConfig = loadCLIConfigForProfile(profile);
      const freshWorkspaces = freshConfig.watched_workspaces || [];
      const existingIds = new Set(workspaceStates.map((ws) => ws.workspaceId));

      const newWorkspaces = freshWorkspaces.filter(
        (ws) => ws.token && !existingIds.has(ws.id),
      );

      for (const ws of newWorkspaces) {
        const runtimes = providers.map((p) => ({ type: p.type, version: p.version }));
        log.info(`Registering new workspace ${ws.id} (${ws.name ?? "unnamed"})...`);
        try {
          const resp = await client.register(ws.token, {
            workspace_id: ws.id,
            daemon_id: config.daemonId,
            device_name: config.deviceName,
            cli_version: config.cliVersion,
            workspaces_root: config.workspacesRoot,
            runtimes,
          });
          const runtimeIds = resp.runtimes.map((r: { id: string }) => r.id);
          workspaceStates.push({ workspaceId: ws.id, token: ws.token, runtimeIds });
          for (let i = 0; i < runtimeIds.length; i++) {
            runtimeIndex.set(runtimeIds[i], {
              id: runtimeIds[i],
              workspaceId: ws.id,
              provider: providers[i].type,
            });
          }
          log.info(`Workspace ${ws.id} added — ${runtimeIds.length} runtime(s)`);
        } catch (e) {
          log.error(`Failed to register new workspace ${ws.id}`, e);
        }
      }

      if (newWorkspaces.length > 0) {
        health.setRuntimeCount(
          workspaceStates.reduce((sum, w) => sum + w.runtimeIds.length, 0),
        );
        log.info(`Reload complete — now polling ${workspaceStates.length} workspace(s)`);
      } else {
        log.info("Reload complete — no new workspaces found");
      }
    } catch (e) {
      log.error("Failed to reload config", e);
    }
  });

  await pollCycle();
}

export function spawnSessionRunner(input: SessionRunnerInput): ChildProcess {
  const logDir = sessionRunnerLogDir();
  mkdirSync(logDir, { recursive: true });

  const logFilePath = join(logDir, `${input.task.id}.log`);
  input.logFilePath = logFilePath;

  const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
  let fd: number | undefined;
  try {
    fd = openSync(logFilePath, "a");
  } catch (e) {
    log.error(`Failed to open log file ${logFilePath}`, e);
  }

  const child = spawn(process.execPath, [sessionRunnerPath, encoded], {
    detached: true,
    stdio: fd != null ? ["ignore", fd, fd] : ["ignore", "ignore", "ignore"],
  });
  child.unref();
  if (fd != null) closeSync(fd);

  return child;
}

export function spawnMeetingRunner(input: {
  meetingId: string;
  meetingUrl: string;
  participants: string[];
  workspaceId: string;
  callbackUrl: string;
  authToken: string;
  agentName?: string;
  agentId?: string;
  timelineDir?: string;
  title?: string;
}): ChildProcess {
  const logDir = sessionRunnerLogDir();
  mkdirSync(logDir, { recursive: true });

  const logFilePath = join(logDir, `meeting-${input.meetingId}.log`);
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
  let fd: number | undefined;
  try {
    fd = openSync(logFilePath, "a");
  } catch (e) {
    log.error(`Failed to open meeting log file ${logFilePath}`, e);
  }

  const child = spawn(process.execPath, [meetingRunnerPath, encoded], {
    detached: true,
    stdio: fd != null ? ["ignore", fd, fd] : ["ignore", "ignore", "ignore"],
  });
  child.unref();
  if (fd != null) closeSync(fd);

  log.info(`Spawned meeting runner for ${input.meetingId} (pid=${child.pid})`);
  return child;
}

async function handleFileRequest(
  client: DaemonClient,
  config: DaemonConfig,
  workspaceId: string,
  req: { id: string; agent_id: string; request_type: string; path: string },
  token: string,
): Promise<void> {
  const agentWorkdir = join(config.workspacesRoot, workspaceId, req.agent_id, "workdir");
  const resolved = validatePath(agentWorkdir, req.path);

  if (!resolved) {
    await client.reportFileData(token, { request_id: req.id, error: "invalid path", path: req.path });
    return;
  }

  try {
    if (req.request_type === "tree") {
      const entries = await readDirectoryTree(resolved, agentWorkdir);
      await client.reportFileData(token, { request_id: req.id, entries, path: req.path });
    } else {
      const { content, isBinary } = await readFileContent(resolved);
      await client.reportFileData(token, { request_id: req.id, content, isBinary, path: req.path });
    }
  } catch (e) {
    await client.reportFileData(token, {
      request_id: req.id,
      error: e instanceof Error ? e.message : String(e),
      path: req.path,
    });
  }
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

  if (task.type === TASK_TYPES.KILL_TASK) {
    const targetTaskId = (task.context as Record<string, unknown>)?.target_task_id as string | undefined;
    if (!targetTaskId) {
      await client.failTask(token, task.id, "missing target_task_id in context");
      activeTasks.delete(task.id);
      return;
    }

    const agentBaseDir = join(config.workspacesRoot, task.workspaceId, task.agentId, "workdir");
    const timelineDir = join(agentBaseDir, ".context_timeline");

    // Retry loop: session-runner may not have written its timeline entry yet
    const MAX_WAIT_MS = Number(process.env.ALOOK_KILL_TASK_MAX_WAIT_MS) || 15_000;
    const POLL_MS = Number(process.env.ALOOK_KILL_TASK_POLL_MS) || 200;
    const waitStart = Date.now();
    let pid: number | null = null;
    while (Date.now() - waitStart < MAX_WAIT_MS) {
      pid = findRunningPidByTaskId(timelineDir, targetTaskId);
      if (pid != null) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    if (pid != null) {
      writeKillIntent(agentBaseDir, {
        reason: "cancelled",
        targetTaskId,
        expectedPid: pid,
      });
      try {
        process.kill(pid, "SIGTERM");
        await client.failTask(token, task.id, "killed");
        log.info(`Kill task ${task.id}: sent SIGTERM to pid=${pid} for target=${targetTaskId}`);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === "ESRCH") {
          await client.failTask(token, task.id, "target process already exited");
          log.info(`Kill task ${task.id}: target pid=${pid} already exited`);
        } else {
          await client.failTask(token, task.id, `kill failed: ${e}`);
        }
      }
    } else {
      await client.failTask(token, task.id, "target not found in timeline");
      log.info(`Kill task ${task.id}: target ${targetTaskId} not found in timeline`);
    }

    activeTasks.delete(task.id);
    return;
  }

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

  // --- Steering: supersede predecessor if same context_key + provider ---
  if (task.contextKey) {
    const agentBaseDir = join(config.workspacesRoot, task.workspaceId, task.agentId, "workdir");
    cleanupStaleIntents(agentBaseDir);
    const timelineDir = join(agentBaseDir, ".context_timeline");

    const lockAcquired = acquireSteeringLock(agentBaseDir, task.contextKey);
    if (!lockAcquired) {
      log.warn(`Steering lock contention for context_key=${task.contextKey}, proceeding without steering`);
    } else {
      try {
        const predecessor = findRunningEntryByContextKey(timelineDir, task.contextKey, provider);
        if (predecessor && predecessor.task_id !== task.id) {
          log.info(`Steering: task ${task.id} supersedes predecessor ${predecessor.task_id} (context_key=${task.contextKey})`);

          if (predecessor.pid != null) {
            writeKillIntent(agentBaseDir, {
              reason: "superseded",
              targetTaskId: predecessor.task_id,
              expectedPid: predecessor.pid,
              successorTaskId: task.id,
            });
            try {
              process.kill(predecessor.pid, "SIGTERM");
              log.info(`Steering: sent SIGTERM to predecessor pid=${predecessor.pid}`);
            } catch (e: unknown) {
              if ((e as NodeJS.ErrnoException)?.code === "ESRCH") {
                log.info(`Steering: predecessor pid=${predecessor.pid} already exited`);
              } else {
                log.warn(`Steering: kill failed for pid=${predecessor.pid}`, e);
              }
            }
            // Wait for predecessor to stop (poll timeline for up to 15 seconds)
            const waitStart = Date.now();
            const MAX_WAIT_MS = 15_000;
            const POLL_MS = 200;
            while (Date.now() - waitStart < MAX_WAIT_MS) {
              const stillRunning = findRunningPidByTaskId(timelineDir, predecessor.task_id);
              if (stillRunning == null) break;
              await new Promise((r) => setTimeout(r, POLL_MS));
            }
            if (findRunningPidByTaskId(timelineDir, predecessor.task_id) != null) {
              log.warn(`Steering: predecessor pid=${predecessor.pid} did not exit within ${MAX_WAIT_MS}ms, proceeding anyway`);
            }
          }

          // Mark predecessor superseded server-side regardless of PID state
          try {
            await client.supersedeTask(token, predecessor.task_id);
            log.info(`Steering: predecessor ${predecessor.task_id} marked superseded`);
          } catch (e) {
            log.warn(`Steering: failed to mark predecessor superseded server-side`, e);
          }
        }
      } finally {
        releaseSteeringLock(agentBaseDir, task.contextKey);
      }
    }
  }

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
    messageInactivityTimeout: config.messageInactivityTimeout,
  };

  const child = spawnSessionRunner(input);
  child.on("close", async (code) => {
    activeTasks.delete(task.id);
    if (code !== 0) {
      const msg = code === null
        ? `session-runner killed by signal (task ${task.id})`
        : `session-runner crashed (exit code ${code}, task ${task.id})`;
      log.warn(msg);

      // Update timeline JSONL as fallback
      const timelineDir = join(config.workspacesRoot, task.workspaceId, task.agentId, "workdir", ".context_timeline");
      updateEntry(timelineDir, task.id, (entry) => {
        entry.pid = null;
        entry.status = "failed";
        entry.errmsg = msg;
      });

      try {
        await client.failTask(token, task.id, msg);
      } catch (e) {
        if (isClientError(e)) {
          log.info(`Backstop: task ${task.id} already in terminal state`);
          return;
        }
        log.error(`Backstop: failed to report crash for task ${task.id}`, e);
        try {
          await writeMarkerFile(config.workspacesRoot, {
            taskId: task.id,
            type: "fail",
            payload: { error: msg },
            token,
            serverURL: config.serverURL,
            createdAt: new Date().toISOString(),
          });
        } catch { /* best-effort */ }
      }
    }
  });
  log.info(`Task ${task.id} dispatched to session-runner (pid=${child.pid})`);
}

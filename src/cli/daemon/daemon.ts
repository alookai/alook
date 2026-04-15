import { DaemonClient } from "./client.js";
import { type DaemonConfig, loadDaemonConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { buildPrompt } from "./prompt.js";
import { createBackend, detectVersion } from "./agent/index.js";
import { type Task, type TaskResult, fromApiTask } from "./types.js";
import { prepare } from "./execenv/index.js";
import { initEntryAsync, updateEntry, createTimelineEntry, localISOString, findResumableSessionId } from "./execenv/timeline.js";
import { loadCLIConfigForProfile } from "../lib/config.js";
import { log } from "../lib/logger.js";
import { cmdPrefix } from "../lib/env.js";
import { createWriteStream } from "fs";
import { execSync } from "child_process";

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
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon(
  profile?: string,
  serverUrl?: string,
): Promise<void> {
  const config = loadDaemonConfig(profile);
  if (serverUrl) config.serverURL = serverUrl;

  const cliConfig = loadCLIConfigForProfile(profile);

  const workspaces = cliConfig.watched_workspaces || [];
  if (workspaces.length === 0) {
    log.error("No watched workspaces configured.");
    process.exit(1);
  }

  // Validate: each workspace must have its own token
  const hasPerWorkspaceTokens = workspaces.every((ws) => !!ws.token);
  if (!hasPerWorkspaceTokens) {
    log.error(
      `Config uses old format. Run '${cmdPrefix()} register --token <token>' for each workspace to upgrade.`,
    );
    process.exit(1);
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
      status: "online",
    }));

    const resp = await client.register(ws.token, {
      workspace_id: ws.id,
      daemon_id: config.daemonId,
      device_name: config.deviceName,
      cli_version: config.cliVersion,
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
  }

  const allRuntimeIds = workspaceStates.flatMap((ws) => ws.runtimeIds);
  health.setRuntimeCount(allRuntimeIds.length);
  log.info(
    `Daemon started — ${allRuntimeIds.length} runtime(s) across ${workspaces.length} workspace(s)`,
  );

  const activeTasks = new Set<string>();

  // Staggered per-workspace polling
  const pollCycle = async () => {
    let remaining = config.maxConcurrentTasks - activeTasks.size;
    if (remaining <= 0) return;

    const N = workspaceStates.length;
    const staggerMs = N > 1 ? Math.floor(config.pollInterval / N) : 0;

    for (let i = 0; i < N; i++) {
      if (remaining <= 0) break;
      const ws = workspaceStates[i];

      if (i > 0 && staggerMs > 0) {
        await new Promise((r) => setTimeout(r, staggerMs));
      }

      try {
        const tasks = await client.poll(ws.token, config.daemonId, remaining);
        for (const apiTask of tasks) {
          const task = fromApiTask(apiTask);
          activeTasks.add(task.id);
          remaining--;
          handleTask(client, config, runtimeIndex, task, ws.token)
            .catch((e) => log.error("Task error", e))
            .finally(() => activeTasks.delete(task.id));
        }
      } catch (e) {
        log.debug("Poll error", e);
      }
    }
  };

  const pollTimer = setInterval(pollCycle, config.pollInterval);

  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(pollTimer);
    const shutdownMs = Number(process.env.ALOOK_SHUTDOWN_TIMEOUT_MS) || 5000;
    const timeout = setTimeout(() => process.exit(1), shutdownMs);
    try {
      for (const ws of workspaceStates) {
        await client.deregister(ws.token, config.daemonId);
      }
    } catch {
      // best-effort deregister
    }
    clearTimeout(timeout);
    health.server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await pollCycle();
}

async function handleTask(
  client: DaemonClient,
  config: DaemonConfig,
  runtimeIndex: Map<string, RuntimeData>,
  task: Task,
  token: string,
): Promise<void> {
  log.info(`Task ${task.id} claimed agent=${task.agentId}`);

  try {
    await client.startTask(token, task.id);
  } catch (e) {
    await client.failTask(token, task.id, `start failed: ${e}`);
    return;
  }

  try {
    const result = await runTask(client, config, runtimeIndex, task, token);
    if (result.status === "completed") {
      const body: {
        output: string;
        session_id?: string;
        branch_name?: string;
      } = { output: result.comment };
      if (result.sessionId) body.session_id = result.sessionId;
      if (result.branchName) body.branch_name = result.branchName;
      await client.completeTask(token, task.id, body);
      log.info(`Task ${task.id} completed`);
    } else {
      await client.failTask(token, task.id, result.comment);
      log.warn(`Task ${task.id} failed — ${result.comment}`);
    }
  } catch (e) {
    await client.failTask(token, task.id, `${e}`);
    log.error(`Task ${task.id} error`, e);
  }
}

async function runTask(
  client: DaemonClient,
  config: DaemonConfig,
  runtimeIndex: Map<string, RuntimeData>,
  task: Task,
  token: string,
): Promise<TaskResult> {
  const runtimeData = runtimeIndex.get(task.runtimeId);
  if (!runtimeData) throw new Error(`unknown runtime: ${task.runtimeId}`);

  const provider = runtimeData.provider;
  const cliPath =
    provider === "claude"
      ? config.claudePath
      : provider === "codex"
        ? config.codexPath
        : config.opencodePath;
  const model =
    provider === "claude"
      ? config.claudeModel
      : provider === "codex"
        ? config.codexModel
        : config.opencodeModel;

  const backend = createBackend(provider, cliPath);

  const prompt = buildPrompt(task);

  const { workDir, logFile, timelineDir, env } = prepare(
    { workspacesRoot: config.workspacesRoot },
    task,
  );

  const resumeSessionId = findResumableSessionId(timelineDir, task.type) ?? undefined;
  if (resumeSessionId) {
    log.info(`Task ${task.id} resuming session ${resumeSessionId}`);
  }

  const session = backend.execute(prompt, {
    cwd: workDir,
    model: model || undefined,
    env,
    timeout: config.agentTimeout,
    resumeSessionId,
  });

  // Context timeline — wait for session ID, then write init entry
  const earlySessionId = await session.sessionId;
  await initEntryAsync(timelineDir, createTimelineEntry(task.id, task.prompt, earlySessionId, session.pid));

  const pendingMessages: {
    seq: number;
    type: string;
    tool?: string;
    call_id?: string;
    content?: string;
    input?: Record<string, unknown>;
    output?: string;
  }[] = [];
  let seq = 0;
  const BATCH_SIZE = Number(process.env.ALOOK_MESSAGE_BATCH_SIZE) || 20;
  const FLUSH_INTERVAL_MS = Number(process.env.ALOOK_MESSAGE_FLUSH_INTERVAL_MS) || 2000;

  const flushMessages = async () => {
    if (pendingMessages.length === 0) return;
    const batch = pendingMessages.splice(0);
    try {
      await client.reportMessages(token, task.id, batch);
    } catch (e) {
      log.debug(`Task ${task.id} message report failed`, e);
    }
  };

  const flushTimer = setInterval(flushMessages, FLUSH_INTERVAL_MS);

  // Log capture — append JSONL to agent.log (best-effort)
  let logStream: ReturnType<typeof createWriteStream> | undefined;
  try {
    logStream = createWriteStream(logFile, { flags: "a" });
    logStream.write(
      JSON.stringify({
        ts: localISOString(),
        type: "text",
        role: "user",
        content: prompt,
      }) + "\n",
    );
  } catch {
    logStream = undefined;
  }

  try {
    for await (const msg of session.messages) {
      seq++;
      pendingMessages.push({
        seq,
        type: msg.type,
        tool: msg.tool,
        call_id: msg.callId,
        content: msg.content,
        input: msg.input,
        output: msg.output,
      });

      // Context timeline — record assistant text messages
      if (msg.type === "text" && msg.content) {
        updateEntry(timelineDir, task.id, (entry) => {
          entry.agent_responses.push(msg.content!);
        });
      }

      if (logStream) {
        try {
          logStream.write(
            JSON.stringify({
              ts: localISOString(),
              role: "assistant",
              ...msg,
            }) + "\n",
          );
        } catch {
          // skip logging on write failure
        }
      }

      if (pendingMessages.length >= BATCH_SIZE) {
        await flushMessages();
      }
    }

    await flushMessages();
  } finally {
    clearInterval(flushTimer);
    logStream?.end();
  }

  const result = await session.result;

  // Context timeline — finalize entry
  if (result.status === "completed") {
    updateEntry(timelineDir, task.id, (entry) => {
      entry.session_id = result.sessionId || null;
      entry.pid = null;
      entry.status = "completed";
    });
  } else {
    updateEntry(timelineDir, task.id, (entry) => {
      entry.pid = null;
      entry.status = "failed";
      entry.errmsg = result.error || "unknown error";
    });
  }

  return {
    status: result.status === "completed" ? "completed" : "failed",
    comment: result.output || result.error,
    sessionId: result.sessionId,
  };
}

import { DaemonClient } from "./client.js";
import { type DaemonConfig, loadDaemonConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { buildPrompt } from "./prompt.js";
import { createBackend, detectVersion } from "./agent/index.js";
import { type Task, type TaskResult, fromApiTask } from "./types.js";
import { loadCLIConfigForProfile } from "../lib/config.js";
import { log } from "../lib/logger.js";
import { mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

interface WorkspaceState {
  workspaceId: string;
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
  if (!cliConfig.token) {
    log.error("Not registered. Run 'alook register' first.");
    process.exit(1);
  }
  if (cliConfig.server_url) config.serverURL = cliConfig.server_url;

  const client = new DaemonClient(config.serverURL, cliConfig.token);
  const health = createHealthServer();

  const workspaces = cliConfig.watched_workspaces || [];
  if (workspaces.length === 0) {
    log.error("No watched workspaces configured.");
    process.exit(1);
  }

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

    const resp = await client.register({
      workspace_id: ws.id,
      daemon_id: config.daemonId,
      device_name: config.deviceName,
      cli_version: config.cliVersion,
      runtimes,
    });

    const runtimeIds = resp.runtimes.map((r: { id: string }) => r.id);
    workspaceStates.push({ workspaceId: ws.id, runtimeIds });

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

  const poll = async () => {
    if (activeTasks.size >= config.maxConcurrentTasks) return;

    for (const rid of allRuntimeIds) {
      if (activeTasks.size >= config.maxConcurrentTasks) break;

      try {
        const resp = await client.claimTask(rid);
        if (resp.task) {
          const task = fromApiTask(resp.task);
          activeTasks.add(task.id);
          handleTask(client, config, runtimeIndex, task)
            .catch((e) => log.error("Task error", e))
            .finally(() => activeTasks.delete(task.id));
        }
      } catch (e) {
        log.debug("Poll error", e);
      }
    }
  };

  const heartbeatTimer = setInterval(async () => {
    for (const rid of allRuntimeIds) {
      try {
        await client.heartbeat(rid);
      } catch (e) {
        log.debug("Heartbeat failed", e);
      }
    }
  }, config.heartbeatInterval);
  const pollTimer = setInterval(poll, config.pollInterval);

  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    const timeout = setTimeout(() => process.exit(1), 5000);
    try {
      await client.deregister(allRuntimeIds);
    } catch {
      // best-effort deregister
    }
    clearTimeout(timeout);
    health.server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await poll();
}

async function handleTask(
  client: DaemonClient,
  config: DaemonConfig,
  runtimeIndex: Map<string, RuntimeData>,
  task: Task,
): Promise<void> {
  log.info(`Task ${task.id} claimed agent=${task.agentId}`);

  try {
    await client.startTask(task.id);
  } catch (e) {
    await client.failTask(task.id, `start failed: ${e}`);
    return;
  }

  try {
    const result = await runTask(client, config, runtimeIndex, task);
    if (result.status === "completed") {
      const body: {
        output: string;
        session_id?: string;
        work_dir?: string;
        branch_name?: string;
      } = { output: result.comment };
      if (result.sessionId) body.session_id = result.sessionId;
      if (result.workDir) body.work_dir = result.workDir;
      if (result.branchName) body.branch_name = result.branchName;
      await client.completeTask(task.id, body);
      log.info(`Task ${task.id} completed`);
    } else {
      await client.failTask(task.id, result.comment);
      log.warn(`Task ${task.id} failed — ${result.comment}`);
    }
  } catch (e) {
    await client.failTask(task.id, `${e}`);
    log.error(`Task ${task.id} error`, e);
  }
}

async function runTask(
  client: DaemonClient,
  config: DaemonConfig,
  runtimeIndex: Map<string, RuntimeData>,
  task: Task,
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

  let prompt = buildPrompt(task);
  if (task.agent?.instructions) {
    prompt = task.agent.instructions + "\n\n" + prompt;
  }

  const workDir = task.priorWorkDir
    ? task.priorWorkDir
    : join(config.workspacesRoot, task.workspaceId, task.agentId, "workdir");
  mkdirSync(workDir, { recursive: true });

  const session = backend.execute(prompt, {
    cwd: workDir,
    model: model || undefined,
    systemPrompt: task.agent?.instructions,
    timeout: config.agentTimeout,
    resumeSessionId: task.priorSessionId,
  });

  const pendingMessages: {
    seq: number;
    type: string;
    tool?: string;
    content?: string;
    input?: Record<string, unknown>;
    output?: string;
  }[] = [];
  let seq = 0;
  const BATCH_SIZE = 20;
  const FLUSH_INTERVAL_MS = 2000;

  const flushMessages = async () => {
    if (pendingMessages.length === 0) return;
    const batch = pendingMessages.splice(0);
    try {
      await client.reportMessages(task.id, batch);
    } catch (e) {
      log.debug(`Task ${task.id} message report failed`, e);
    }
  };

  const flushTimer = setInterval(flushMessages, FLUSH_INTERVAL_MS);

  try {
    for await (const msg of session.messages) {
      seq++;
      pendingMessages.push({
        seq,
        type: msg.type,
        tool: msg.tool,
        content: msg.content,
        input: msg.input,
        output: msg.output,
      });

      if (pendingMessages.length >= BATCH_SIZE) {
        await flushMessages();
      }
    }

    await flushMessages();
  } finally {
    clearInterval(flushTimer);
  }

  const result = await session.result;
  return {
    status: result.status === "completed" ? "completed" : "failed",
    comment: result.output || result.error,
    sessionId: result.sessionId,
    workDir,
  };
}

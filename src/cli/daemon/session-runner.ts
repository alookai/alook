/**
 * Session Runner — standalone process that executes a single agent task.
 *
 * Spawned by the daemon as a detached child (`spawn('bun', ['run', thisFile, base64Input])`).
 * Survives daemon restarts: owns the full lifecycle of message syncing, timeline writes,
 * log capture, and server completion reporting.
 */

import { mkdir, writeFile, rm, rename } from "fs/promises";
import path from "path";
import { DaemonClient } from "./client.js";
import { createBackend } from "./agent/index.js";
import { prepare } from "./execenv/index.js";
import {
  initEntryAsync,
  updateEntry,
  createTimelineEntry,
  findResumableSessionByContextKey,
} from "./execenv/timeline.js";
import { readKillIntent, clearKillIntent } from "./execenv/steering.js";
import { buildPrompt } from "./prompt.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger({ module: "session-runner" });
import { tempDir } from "../lib/platform.js";
import type { SessionRunnerInput, Attachment } from "./types.js";

const ATTACHMENTS_BASE = tempDir("alook-attachments");

// --- Marker file support for resilient server reporting ---

export type MarkerData =
  | {
      taskId: string;
      type: "complete";
      payload: { output: string; session_id?: string; branch_name?: string };
      token: string;
      serverURL: string;
      createdAt: string;
    }
  | {
      taskId: string;
      type: "fail";
      payload: { error: string };
      token: string;
      serverURL: string;
      createdAt: string;
    };

export async function writeMarkerFile(
  workspacesRoot: string,
  marker: MarkerData,
): Promise<void> {
  const dir = path.join(workspacesRoot, ".pending_completions");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `${marker.taskId}.tmp`);
  const finalPath = path.join(dir, `${marker.taskId}.json`);
  await writeFile(tmpPath, JSON.stringify(marker), { mode: 0o600 });
  await rename(tmpPath, finalPath);
}

export async function reportToServer(
  fn: () => Promise<unknown>,
  markerData: MarkerData,
  workspacesRoot: string,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.warn(`server report failed for task ${markerData.taskId}, writing marker: ${e}`);
    try {
      await writeMarkerFile(workspacesRoot, markerData);
    } catch (writeErr) {
      log.error(`marker write also failed for task ${markerData.taskId}: ${writeErr}`);
    }
  }
}

function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[/\\]/g, "_").replace(/\.\./g, "_").slice(0, 255) || "file";
}

async function cleanupAttachments(taskId: string): Promise<void> {
  try {
    await rm(path.join(ATTACHMENTS_BASE, taskId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

async function downloadAttachments(
  client: DaemonClient,
  token: string,
  workspaceId: string,
  taskId: string,
  attachmentIds: string[],
): Promise<Attachment[]> {
  const dir = path.join(ATTACHMENTS_BASE, taskId);
  await mkdir(dir, { recursive: true });

  const attachments: Attachment[] = [];
  for (const artId of attachmentIds) {
    const meta = await client.getArtifactMeta(token, artId, workspaceId);
    const content = await client.downloadArtifact(token, artId, workspaceId);
    const filename = sanitizeFilename(meta.filename);
    const localPath = path.join(dir, `${artId}_${filename}`);
    await writeFile(localPath, Buffer.from(content));
    attachments.push({
      path: localPath,
      content_type: meta.content_type,
      filename: meta.filename,
    });
  }
  return attachments;
}

export async function runSession(input: SessionRunnerInput): Promise<void> {
  const { task, provider, cliPath, model, serverURL, token, workspacesRoot, agentTimeout, messageInactivityTimeout } = input;

  log.info(`starting (task=${task.id}, type=${task.type}, agent=${task.agentId}, provider=${provider}, model=${model || "default"})`);

  const client = new DaemonClient(serverURL);
  const backend = createBackend(provider, cliPath);

  const { workDir, timelineDir, env } = prepare(
    { workspacesRoot },
    task,
  );

  const agentBaseDir = path.dirname(timelineDir);

  // Timeline entry: write IMMEDIATELY so KILL_TASK can find our PID
  await initEntryAsync(
    timelineDir,
    createTimelineEntry(task.id, task.prompt, task.type, undefined, process.pid, provider, task.contextKey, input.logFilePath),
  );

  let killed = false;

  // Early signal handler (before agent starts — no agentPid/flushTimer yet)
  const earlyOnKill = async () => {
    if (killed) return;
    killed = true;
    log.info(`killed by signal (messages=0, tools=0)`);

    await cleanupAttachments(task.id);

    const intent = readKillIntent(agentBaseDir, task.id);
    clearKillIntent(agentBaseDir, task.id);

    if (intent?.reason === "superseded") {
      updateEntry(timelineDir, task.id, (entry) => {
        entry.pid = null;
        entry.status = "superseded";
        entry.successor_task_id = intent.successorTaskId ?? null;
        entry.supersede_reason = "superseded by newer task";
      });
      try {
        await client.supersedeTask(token, task.id);
      } catch { /* best-effort */ }
    } else if (intent?.reason === "cancelled") {
      updateEntry(timelineDir, task.id, (entry) => {
        entry.pid = null;
        entry.status = "cancelled";
        entry.errmsg = "cancelled by user";
      });
      await reportToServer(
        () => client.failTask(token, task.id, "cancelled by user"),
        { taskId: task.id, type: "fail", payload: { error: "cancelled by user" }, token, serverURL, createdAt: new Date().toISOString() },
        workspacesRoot,
      );
    } else {
      updateEntry(timelineDir, task.id, (entry) => {
        entry.pid = null;
        entry.status = "killed";
        entry.errmsg = "killed by signal";
      });
      await reportToServer(
        () => client.failTask(token, task.id, "killed by signal"),
        { taskId: task.id, type: "fail", payload: { error: "killed by signal" }, token, serverURL, createdAt: new Date().toISOString() },
        workspacesRoot,
      );
    }

    process.exit(1);
  };
  process.on("SIGTERM", earlyOnKill);
  process.on("SIGINT", earlyOnKill);

  // Download attachments before building prompt
  const attachmentIds = (task.context?.attachment_ids as string[]) ?? [];
  let attachments: Attachment[] | undefined;
  if (attachmentIds.length > 0) {
    log.info(`downloading ${attachmentIds.length} attachment(s)`);
    try {
      attachments = await downloadAttachments(client, token, task.workspaceId, task.id, attachmentIds);
      log.info(`attachments ready (${attachments.length} file(s))`);
    } catch (e) {
      await cleanupAttachments(task.id);
      const errMsg = `failed to download attachments: ${e}`;
      log.error(errMsg);
      updateEntry(timelineDir, task.id, (entry) => {
        entry.pid = null;
        entry.status = "failed";
        entry.errmsg = errMsg;
      });
      await client.failTask(token, task.id, errMsg);
      process.removeListener("SIGTERM", earlyOnKill);
      process.removeListener("SIGINT", earlyOnKill);
      return;
    }
  }

  const prompt = buildPrompt(task, attachments);

  const resumeSessionId = task.contextKey
    ? findResumableSessionByContextKey(timelineDir, task.contextKey, provider) ?? undefined
    : undefined;
  if (resumeSessionId) {
    log.info(`resuming session ${resumeSessionId} (context_key: ${task.contextKey})`);
  }

  const session = backend.execute(prompt, {
    cwd: workDir,
    model: model || undefined,
    env,
    timeout: agentTimeout,
    resumeSessionId,
  });

  // Capture agent PID for signal handler
  const agentPid = session.pid;

  // Update timeline entry with session_id once agent starts
  const earlySessionId = await session.sessionId;
  log.info(`agent started (pid=${agentPid ?? "unknown"}, session=${earlySessionId})`);
  log.info(JSON.stringify({ role: "user", type: "text", content: prompt }));
  updateEntry(timelineDir, task.id, (entry) => {
    entry.session_id = earlySessionId || null;
  });

  // Message batching
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
  let toolCount = 0;
  const BATCH_SIZE = Number(process.env.ALOOK_MESSAGE_BATCH_SIZE) || 20;
  const FLUSH_INTERVAL_MS = Number(process.env.ALOOK_MESSAGE_FLUSH_INTERVAL_MS) || 100;

  const flushMessages = async () => {
    if (pendingMessages.length === 0) return;
    const batch = pendingMessages.splice(0);
    try {
      await client.reportMessages(token, task.id, batch);
    } catch (e) {
      log.debug("message report failed", e);
    }
  };

  const flushTimer = setInterval(flushMessages, FLUSH_INTERVAL_MS);

  // --- Replace early signal handler with full one ---
  process.removeListener("SIGTERM", earlyOnKill);
  process.removeListener("SIGINT", earlyOnKill);

  const onKill = async () => {
    if (killed) return;
    killed = true;
    log.info(`killed by signal (messages=${seq}, tools=${toolCount})`);

    // 1. Kill the inner agent process
    if (agentPid) {
      try { process.kill(agentPid, "SIGTERM"); } catch { /* already dead */ }
    }

    // 2. Flush any pending messages
    clearInterval(flushTimer);
    try { await flushMessages(); } catch { /* best-effort */ }

    // 3. Cleanup attachments
    await cleanupAttachments(task.id);

    // 4. Read kill-intent to determine reason
    const intent = readKillIntent(agentBaseDir, task.id);
    clearKillIntent(agentBaseDir, task.id);

    if (intent?.reason === "superseded") {
      // Superseded: update timeline and report via dedicated API
      updateEntry(timelineDir, task.id, (entry) => {
        entry.pid = null;
        entry.status = "superseded";
        entry.successor_task_id = intent.successorTaskId ?? null;
        entry.supersede_reason = "superseded by newer task";
      });
      try {
        await client.supersedeTask(token, task.id);
      } catch { /* best-effort — daemon steering may have already marked it */ }
    } else if (intent?.reason === "cancelled") {
      // User cancel: update timeline to cancelled (not killed)
      updateEntry(timelineDir, task.id, (entry) => {
        entry.pid = null;
        entry.status = "cancelled";
        entry.errmsg = "cancelled by user";
      });
      await reportToServer(
        () => client.failTask(token, task.id, "cancelled by user"),
        { taskId: task.id, type: "fail", payload: { error: "cancelled by user" }, token, serverURL, createdAt: new Date().toISOString() },
        workspacesRoot,
      );
    } else {
      // No intent file: preserve existing behavior
      updateEntry(timelineDir, task.id, (entry) => {
        entry.pid = null;
        entry.status = "killed";
        entry.errmsg = "killed by signal";
      });
      await reportToServer(
        () => client.failTask(token, task.id, "killed by signal"),
        { taskId: task.id, type: "fail", payload: { error: "killed by signal" }, token, serverURL, createdAt: new Date().toISOString() },
        workspacesRoot,
      );
    }

    process.exit(1);
  };
  process.on("SIGTERM", onKill);
  process.on("SIGINT", onKill);

  // Message inactivity timeout — kill hung agent if no messages arrive within the window
  const INACTIVITY_TIMEOUT_MS = messageInactivityTimeout ?? 5 * 60 * 1000;
  let inactivityTimedOut = false;

  try {
    const iter = session.messages[Symbol.asyncIterator]();
    while (!killed) {
      const next = iter.next();
      const raceResult = await (INACTIVITY_TIMEOUT_MS > 0
        ? Promise.race([
            next,
            new Promise<"timeout">((resolve) => {
              const timer = setTimeout(() => resolve("timeout"), INACTIVITY_TIMEOUT_MS);
              next.then(() => clearTimeout(timer), () => clearTimeout(timer));
            }),
          ])
        : next);

      if (raceResult === "timeout") {
        inactivityTimedOut = true;
        log.warn(`message inactivity timeout (${INACTIVITY_TIMEOUT_MS / 1000}s) — killing agent`);
        if (session.pid) {
          try { process.kill(session.pid, "SIGTERM"); } catch { /* already dead */ }
        }
        iter.return?.(undefined as never);
        break;
      }

      const iterResult = raceResult as IteratorResult<import("./types.js").AgentMessage>;
      if (iterResult.done) break;

      const msg = iterResult.value;
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

      if (msg.type === "tool-use") toolCount++;
      if (msg.type === "tool-result" && msg.output && msg.output.length > 500) {
        log.info(JSON.stringify({ role: "assistant", ...msg, output: msg.output.slice(0, 500) + `... (${msg.output.length} chars)` }));
      } else {
        log.info(JSON.stringify({ role: "assistant", ...msg }));
      }

      // Timeline — record assistant text messages
      if (msg.type === "text" && msg.content) {
        updateEntry(timelineDir, task.id, (entry) => {
          entry.agent_responses.push(msg.content!);
        });
      }

      if (pendingMessages.length >= BATCH_SIZE) {
        await flushMessages();
      }
    }

    if (!killed) await flushMessages();
  } finally {
    clearInterval(flushTimer);
    process.removeListener("SIGTERM", onKill);
    process.removeListener("SIGINT", onKill);
  }

  if (killed) return;

  // Re-register signal handlers for the duration of result awaiting
  process.on("SIGTERM", onKill);
  process.on("SIGINT", onKill);

  const result = await session.result;

  // Remove signal handlers — normal completion takes over
  process.removeListener("SIGTERM", onKill);
  process.removeListener("SIGINT", onKill);

  if (killed) return;

  // Override result on inactivity timeout
  if (inactivityTimedOut) {
    result.status = "failed";
    result.error = `message inactivity timeout (no messages for ${INACTIVITY_TIMEOUT_MS / 1000}s)`;
  }

  // Cleanup attachments after task completion
  await cleanupAttachments(task.id);

  // Timeline — finalize entry
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
      entry.errmsg = result.error || "agent exited unexpectedly";
    });
  }

  // Report to server
  if (result.status === "completed") {
    const body: { output: string; session_id?: string; branch_name?: string } = {
      output: result.output || "",
    };
    if (result.sessionId) body.session_id = result.sessionId;
    // branchName is currently always undefined — forward-compat passthrough
    await reportToServer(
      () => client.completeTask(token, task.id, body),
      { taskId: task.id, type: "complete", payload: body, token, serverURL, createdAt: new Date().toISOString() },
      workspacesRoot,
    );
    const dur = (result.durationMs / 1000).toFixed(1);
    log.info(`completed (duration=${dur}s, messages=${seq}, tools=${toolCount})`);
  } else {
    const errorMsg = result.error || "agent exited unexpectedly";
    await reportToServer(
      () => client.failTask(token, task.id, errorMsg),
      { taskId: task.id, type: "fail", payload: { error: errorMsg }, token, serverURL, createdAt: new Date().toISOString() },
      workspacesRoot,
    );
    const dur = (result.durationMs / 1000).toFixed(1);
    log.info(`failed (duration=${dur}s, messages=${seq}, tools=${toolCount}) — ${result.error}`);
  }
}

// --- Entry point when run as a standalone process ---

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded) {
    log.error("session-runner: missing base64-encoded input argument");
    process.exit(1);
  }

  let input: SessionRunnerInput;
  try {
    const json = Buffer.from(encoded, "base64").toString("utf-8");
    input = JSON.parse(json);
  } catch (e) {
    log.error("session-runner: failed to parse input", e);
    process.exit(1);
  }

  const client = new DaemonClient(input.serverURL);

  try {
    await runSession(input);
  } catch (e) {
    log.error(`session-runner: unhandled error for task ${input.task.id}`, e);
    await cleanupAttachments(input.task.id);
    const errorMsg = `session-runner crash: ${e}`;
    await reportToServer(
      () => client.failTask(input.token, input.task.id, errorMsg),
      { taskId: input.task.id, type: "fail", payload: { error: errorMsg }, token: input.token, serverURL: input.serverURL, createdAt: new Date().toISOString() },
      input.workspacesRoot,
    );
    process.exit(1);
  }
}

// Only run main() when executed directly (not when imported for testing)
const isDirectExecution =
  typeof Bun !== "undefined"
    ? Bun.main === import.meta.path
    : process.argv[1]?.endsWith("session-runner.ts") || process.argv[1]?.endsWith("session-runner.js");

if (isDirectExecution) {
  main();
}

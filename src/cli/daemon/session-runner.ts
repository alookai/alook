/**
 * Session Runner — standalone process that executes a single agent task.
 *
 * Spawned by the daemon as a detached child (`spawn('bun', ['run', thisFile, base64Input])`).
 * Survives daemon restarts: owns the full lifecycle of message syncing, timeline writes,
 * log capture, and server completion reporting.
 */

import { mkdir, writeFile, rm } from "fs/promises";
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
import { buildPrompt } from "./prompt.js";
import { log } from "../lib/logger.js";
import type { SessionRunnerInput, Attachment } from "./types.js";

const ATTACHMENTS_BASE = "/tmp/alook-attachments";

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
  const { task, provider, cliPath, model, serverURL, token, workspacesRoot, agentTimeout } = input;

  log.info(`starting (task=${task.id}, type=${task.type}, agent=${task.agentId}, provider=${provider}, model=${model || "default"})`);

  const client = new DaemonClient(serverURL);
  const backend = createBackend(provider, cliPath);

  const { workDir, timelineDir, env } = prepare(
    { workspacesRoot },
    task,
  );

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
      await client.failTask(token, task.id, errMsg);
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

  // Timeline init — use process.pid (session runner PID), not the inner agent PID
  const earlySessionId = await session.sessionId;
  log.info(`agent started (pid=${agentPid ?? "unknown"}, session=${earlySessionId})`);
  log.info(JSON.stringify({ role: "user", type: "text", content: prompt }));
  await initEntryAsync(
    timelineDir,
    createTimelineEntry(task.id, task.prompt, task.type, earlySessionId, process.pid, provider, task.contextKey, input.logFilePath),
  );

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

  // --- Graceful shutdown on SIGTERM/SIGINT ---
  let killed = false;
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

    // 4. Update timeline — status "killed"
    updateEntry(timelineDir, task.id, (entry) => {
      entry.pid = null;
      entry.status = "killed";
      entry.errmsg = "killed by signal";
    });

    // 5. Report to server
    try {
      await client.failTask(token, task.id, "killed by signal");
    } catch { /* best-effort */ }

    process.exit(1);
  };
  process.on("SIGTERM", onKill);
  process.on("SIGINT", onKill);

  try {
    for await (const msg of session.messages) {
      if (killed) break;
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
      log.info(JSON.stringify({ role: "assistant", ...msg }));

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
      entry.errmsg = result.error || "unknown error";
    });
  }

  // Report to server
  if (result.status === "completed") {
    const body: { output: string; session_id?: string; branch_name?: string } = {
      output: result.output || "",
    };
    if (result.sessionId) body.session_id = result.sessionId;
    // branchName is currently always undefined — forward-compat passthrough
    await client.completeTask(token, task.id, body);
    const dur = (result.durationMs / 1000).toFixed(1);
    log.info(`completed (duration=${dur}s, messages=${seq}, tools=${toolCount})`);
  } else {
    await client.failTask(token, task.id, result.error || "unknown error");
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
    try {
      await client.failTask(input.token, input.task.id, `session-runner crash: ${e}`);
    } catch {
      // best-effort
    }
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

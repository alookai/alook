/**
 * Session Runner — standalone process that executes a single agent task.
 *
 * Spawned by the daemon as a detached child (`spawn('bun', ['run', thisFile, base64Input])`).
 * Survives daemon restarts: owns the full lifecycle of message syncing, timeline writes,
 * log capture, and server completion reporting.
 */

import { createWriteStream } from "fs";
import { DaemonClient } from "./client.js";
import { createBackend } from "./agent/index.js";
import { prepare } from "./execenv/index.js";
import {
  initEntryAsync,
  updateEntry,
  createTimelineEntry,
  localISOString,
  findResumableSessionByContextKey,
} from "./execenv/timeline.js";
import { buildPrompt } from "./prompt.js";
import { log } from "../lib/logger.js";
import type { SessionRunnerInput } from "./types.js";

export async function runSession(input: SessionRunnerInput): Promise<void> {
  const { task, provider, cliPath, model, serverURL, token, workspacesRoot, agentTimeout } = input;

  const client = new DaemonClient(serverURL);
  const backend = createBackend(provider, cliPath);
  const prompt = buildPrompt(task);

  const { workDir, logFile, timelineDir, env } = prepare(
    { workspacesRoot },
    task,
  );

  const resumeSessionId = task.contextKey
    ? findResumableSessionByContextKey(timelineDir, task.contextKey, provider) ?? undefined
    : undefined;
  if (resumeSessionId) {
    log.info(`Task ${task.id} resuming session ${resumeSessionId} (context_key: ${task.contextKey})`);
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
  await initEntryAsync(
    timelineDir,
    createTimelineEntry(task.id, task.prompt, task.type, earlySessionId, process.pid, provider, task.contextKey),
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
  const BATCH_SIZE = Number(process.env.ALOOK_MESSAGE_BATCH_SIZE) || 20;
  const FLUSH_INTERVAL_MS = Number(process.env.ALOOK_MESSAGE_FLUSH_INTERVAL_MS) || 100;

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

  // --- Graceful shutdown on SIGTERM/SIGINT ---
  let killed = false;
  const onKill = async () => {
    if (killed) return;
    killed = true;
    log.info(`Task ${task.id} killed by signal`);

    // 1. Kill the inner agent process
    if (agentPid) {
      try { process.kill(agentPid, "SIGTERM"); } catch { /* already dead */ }
    }

    // 2. Flush any pending messages
    clearInterval(flushTimer);
    try { await flushMessages(); } catch { /* best-effort */ }
    logStream?.end();

    // 3. Update timeline — status "killed"
    updateEntry(timelineDir, task.id, (entry) => {
      entry.pid = null;
      entry.status = "killed";
      entry.errmsg = "killed by signal";
    });

    // 4. Report to server
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

      // Timeline — record assistant text messages
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

    if (!killed) await flushMessages();
  } finally {
    clearInterval(flushTimer);
    logStream?.end();
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
    log.info(`Task ${task.id} completed`);
  } else {
    await client.failTask(token, task.id, result.error || "unknown error");
    log.info(`Task ${task.id} failed — ${result.error}`);
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

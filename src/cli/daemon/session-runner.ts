/**
 * Session Runner — standalone process that executes a single agent task.
 *
 * Spawned by the daemon as a detached child (`spawn('bun', ['run', thisFile, base64Input])`).
 * Survives daemon restarts: owns the full lifecycle of message syncing, timeline writes,
 * log capture, and server completion reporting.
 */

import { mkdir, writeFile, rm, rename } from "fs/promises";
import { mkdirSync } from "fs";
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
import { watchInbox, writeAck, writeNack, cleanupInboxFile, cleanupSteeringDir, type MailboxWatcher } from "./steering/mailbox.js";
import { RuntimeTurnState } from "./steering/turnState.js";
import {
  createInitialApmState,
  reduceApmGatedToolUse,
  reduceApmGatedCompaction,
  reduceApmGatedEnqueue,
  reduceApmGatedTurnEnd,
  reduceApmGatedError,
  reduceApmGatedFlushReadiness,
  reduceApmGatedRecentEvent,
  reduceApmStalledRecoveryTermination,
  reduceApmStartupTimeoutTermination,
} from "./steering/apmStateMachine.js";
import { RuntimeNotificationState } from "./steering/notificationState.js";
import { RuntimeProgressState } from "./steering/progressState.js";
import { classifyRuntimeError, scrubDiagnosticText } from "./steering/errorDiagnostics.js";
import { killProcessTree } from "./kill-tree.js";
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

function isRetryableError(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  const msg = e.message;
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN/.test(msg)) return true;
  const httpMatch = msg.match(/^HTTP (\d+):/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    return false;
  }
  return true;
}

function isClientError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const match = e.message.match(/^HTTP (\d+):/);
  if (!match) return false;
  const status = Number(match[1]);
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

export async function reportToServer(
  fn: () => Promise<unknown>,
  markerData: MarkerData,
  workspacesRoot: string,
): Promise<void> {
  const RETRY_DELAYS = [1000, 3000, 9000];
  let lastErr: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      lastErr = e;
      if (isClientError(e)) {
        log.info(`server report for task ${markerData.taskId}: task already in terminal state (${e})`);
        return;
      }
      if (attempt < RETRY_DELAYS.length && isRetryableError(e)) {
        log.debug(`server report attempt ${attempt + 1} failed for task ${markerData.taskId}, retrying in ${RETRY_DELAYS[attempt]}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }

  log.warn(`server report failed for task ${markerData.taskId} after retries, writing marker: ${lastErr}`);
  try {
    await writeMarkerFile(workspacesRoot, markerData);
  } catch (writeErr) {
    log.error(`marker write also failed for task ${markerData.taskId}: ${writeErr}`);
  }
}

function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[/\\]/g, "_").replace(/\.\./g, "_").slice(0, 255) || "file";
}

export async function cleanupAttachments(taskId: string): Promise<void> {
  try {
    await rm(path.join(ATTACHMENTS_BASE, taskId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export async function downloadAttachments(
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

  // Compute timelineDir before prepare() so timeline entry exists even on early crashes
  const agentBaseDir = path.join(workspacesRoot, task.workspaceId, task.agentId, "workdir");
  const timelineDir = path.join(agentBaseDir, ".context_timeline").replace(/\\/g, "/");
  mkdirSync(timelineDir, { recursive: true });

  // Timeline entry: write IMMEDIATELY so KILL_TASK can find our PID
  await initEntryAsync(
    timelineDir,
    createTimelineEntry(task.id, task.prompt, task.type, undefined, process.pid, provider, task.contextKey, input.logFilePath),
  );

  const { workDir, env } = prepare(
    { workspacesRoot, token },
    task,
  );

  // --- State shared by the kill handler, hoisted so the SINGLE handler below
  //     can see it whether the kill lands before or after the agent spawns. ---
  let killed = false;
  // Assigned once after the agent spawns (below) but READ earlier inside onKill;
  // prefer-const can't see the closure read, so it must stay `let`.
  // eslint-disable-next-line prefer-const
  let agentPid: number | undefined;
  // eslint-disable-next-line prefer-const
  let flushTimer: ReturnType<typeof setInterval> | undefined;

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

  let mailboxWatcher: MailboxWatcher | null = null;
  let stalledRecoveryTimer: ReturnType<typeof setInterval> | undefined;

  // --- Single SIGTERM/SIGINT handler, registered ONCE for the whole lifetime.
  //     Every field it touches is guarded for the "not yet initialized" window
  //     (kill arriving before the agent is spawned / batching has started). ---
  const onKill = async () => {
    if (killed) return;
    killed = true;
    log.info(`killed by signal (messages=${seq}, tools=${toolCount})`);

    // 0. Stop mailbox watcher and stalled recovery timer (if running)
    if (mailboxWatcher) mailboxWatcher.stop();
    if (stalledRecoveryTimer) clearInterval(stalledRecoveryTimer);

    // 1. Kill the inner agent process group (CLI + tool/MCP subprocesses),
    //    escalating to SIGKILL if it ignores SIGTERM. No-op if not yet spawned.
    if (agentPid !== undefined) {
      log.info(`killing inner agent group (pid=${agentPid})`);
      await killProcessTree(agentPid);
    }

    // 2. Flush any pending messages
    if (flushTimer) clearInterval(flushTimer);
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
      await reportToServer(
        () => client.failTask(token, task.id, errMsg),
        { taskId: task.id, type: "fail", payload: { error: errMsg }, token, serverURL, createdAt: new Date().toISOString() },
        workspacesRoot,
      );
      // Leave onKill installed until the very end — no window where the pid is
      // findable but unhandled. agentPid is still undefined, so onKill just reports.
      process.removeListener("SIGTERM", onKill);
      process.removeListener("SIGINT", onKill);
      return;
    }
  }

  // A kill may have arrived during attachment download (onKill set killed=true
  // and called process.exit — but if exit hasn't flushed yet, don't spawn).
  if (killed) return;

  const prompt = input.promptOverride ?? buildPrompt(task, attachments);

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
    steeringEnabled: input.steeringEnabled,
  });

  // Capture agent PID so the handler can reap it. backend.execute() spawns
  // synchronously and returns immediately, so the only gap is the JS between
  // the timeline write and here — closed by the re-check below.
  agentPid = session.pid;

  // If a kill landed while the agent was spawning, the handler ran with
  // agentPid===undefined and killed nothing. Reap the freshly-spawned process
  // now and exit before streaming starts.
  if (killed) {
    if (agentPid !== undefined) {
      log.info(`kill landed during spawn — reaping inner agent group (pid=${agentPid})`);
      await killProcessTree(agentPid);
    }
    process.exit(1);
  }

  // Update timeline entry with session_id once agent starts
  const earlySessionId = await session.sessionId;
  log.info(`agent started (pid=${agentPid ?? "unknown"}, session=${earlySessionId})`);
  log.info(JSON.stringify({ role: "user", type: "text", content: prompt }));
  updateEntry(timelineDir, task.id, (entry) => {
    entry.session_id = earlySessionId || null;
    // Mark the agent as genuinely started so steering may supersede this run.
    // Gate on a non-empty session id: codex resolves sessionId to "" if its
    // thread/start handshake fails before completing — that is NOT a started
    // agent, so leave the marker falsy and let the staleness path reap it.
    if (earlySessionId) entry.agent_started = true;
  });

  flushTimer = setInterval(flushMessages, FLUSH_INTERVAL_MS);

  // --- Steering: mailbox watcher + state machines ---
  const turnState = new RuntimeTurnState();
  let apmState = createInitialApmState();
  const notificationState = new RuntimeNotificationState();
  const progressState = new RuntimeProgressState();
  const pendingSteeredTasks = new Set<string>();
  const pendingAcks: { seq: string; sessionId: string }[] = [];
  let hasReceivedProgressEvent = false;

  if (input.steeringEnabled && input.steeringMailboxDir && task.contextKey) {
    const descriptor = session.descriptor;
    const STALLED_THRESHOLD_MS = 120_000; // 2 minutes
    const STALLED_CHECK_INTERVAL_MS = 30_000; // 30 seconds

    // Start a background ParsedEvent consumer for steering state machine updates
    if (session.parsedEvents) {
      const parsedIter = session.parsedEvents[Symbol.asyncIterator]();
      const consumeParsedEvents = async () => {
        try {
          while (!killed) {
            const { value: event, done } = await parsedIter.next();
            if (done) break;

            hasReceivedProgressEvent = true;

            // Track progress for granular liveness detection
            progressState.processEvent(event);

            // Record recent event for diagnostics
            const recentResult = reduceApmGatedRecentEvent(apmState, { event: event.kind });
            apmState = recentResult.nextState;

            // Classify errors for structured diagnostics + update APM state
            if (event.kind === "error") {
              const classified = classifyRuntimeError(event.message);
              log.info(`steering: error classified as ${classified.errorClass}: ${scrubDiagnosticText(event.message)}`);
              const errResult = reduceApmGatedError(apmState, { disableToolBoundaryFlush: true });
              apmState = errResult.nextState;
            }

            // turnState gate transitions — BEFORE reducer calls
            switch (event.kind) {
              case "tool_call":
              case "thinking":
              case "compaction_started":
                turnState.markToolBoundary();
                break;
              case "text":
              case "tool_output":
              case "compaction_finished":
                turnState.markProgress();
                break;
            }

            switch (event.kind) {
              case "session_init":
                turnState.markTurnStarted(event.sessionId);
                break;
              case "text":
                if (!turnState.isInTurn) turnState.markTurnStarted();
                break;
              case "tool_call": {
                if (!turnState.isInTurn) turnState.markTurnStarted();
                const result = reduceApmGatedToolUse(apmState, { kind: "tool_call" });
                apmState = result.nextState;
                break;
              }
              case "tool_output": {
                const result = reduceApmGatedToolUse(apmState, { kind: "tool_output" });
                apmState = result.nextState;
                if (result.shouldFlushToolBatch && session.send && apmState.pendingMessages.length > 0) {
                  const readiness = reduceApmGatedFlushReadiness(apmState, {
                    isGated: descriptor?.busyDeliveryMode === "gated",
                    hasSession: !!earlySessionId,
                    inboxLength: apmState.pendingMessages.length,
                    reason: "tool_batch_complete",
                  });
                  if (readiness.shouldNotify) {
                    let allSent = true;
                    for (const msg of apmState.pendingMessages) {
                      const sendResult = session.send(msg, "busy");
                      if (!sendResult.ok) { allSent = false; break; }
                    }
                    if (allSent) {
                      apmState = { ...apmState, pendingMessages: [] };
                      for (const ack of pendingAcks) {
                        notificationState.recordNoticeWritten(String(ack.seq), ack.sessionId, [{ id: String(ack.seq) }]);
                        writeAck(agentBaseDir, task.contextKey!, ack.seq);
                      }
                      pendingAcks.length = 0;
                    }
                  }
                }
                break;
              }
              case "compaction_started":
              case "compaction_finished": {
                const result = reduceApmGatedCompaction(apmState, { kind: event.kind });
                apmState = result.nextState;
                if (event.kind === "compaction_finished" && session.send && apmState.pendingMessages.length > 0) {
                  const readiness = reduceApmGatedFlushReadiness(apmState, {
                    isGated: descriptor?.busyDeliveryMode === "gated",
                    hasSession: !!earlySessionId,
                    inboxLength: apmState.pendingMessages.length,
                    reason: "compaction_finished",
                  });
                  if (readiness.shouldNotify) {
                    let allSent = true;
                    for (const msg of apmState.pendingMessages) {
                      const sendResult = session.send(msg, "busy");
                      if (!sendResult.ok) { allSent = false; break; }
                    }
                    if (allSent) {
                      apmState = { ...apmState, pendingMessages: [] };
                      for (const ack of pendingAcks) {
                        notificationState.recordNoticeWritten(String(ack.seq), ack.sessionId, [{ id: String(ack.seq) }]);
                        writeAck(agentBaseDir, task.contextKey!, ack.seq);
                      }
                      pendingAcks.length = 0;
                    }
                  }
                }
                break;
              }
              case "turn_end": {
                const result = reduceApmGatedTurnEnd(apmState, {
                  inboxLength: apmState.pendingMessages.length,
                  supportsStdinNotification: descriptor?.supportsStdinNotification,
                  hasSession: !!earlySessionId,
                });
                apmState = result.nextState;
                let flushedOk = false;
                for (const eff of result.effects) {
                  if (eff.kind === "deliver_stdin" && session.send) {
                    let allSent = true;
                    for (const msg of apmState.pendingMessages) {
                      const sendResult = session.send(msg, eff.stdinMode);
                      if (!sendResult.ok) {
                        log.warn("steering: send failed during turn_end flush", { reason: sendResult.reason });
                        allSent = false;
                        break;
                      }
                    }
                    if (allSent) {
                      apmState = { ...apmState, pendingMessages: [] };
                      flushedOk = true;
                    }
                  }
                }
                // Write deferred acks only after successful flush
                if (flushedOk && pendingAcks.length > 0) {
                  for (const ack of pendingAcks) {
                    notificationState.recordNoticeWritten(String(ack.seq), ack.sessionId, [{ id: String(ack.seq) }]);
                    writeAck(agentBaseDir, task.contextKey!, ack.seq);
                  }
                  pendingAcks.length = 0;
                }
                // Complete pending steered tasks only after successful delivery
                if (flushedOk || apmState.pendingMessages.length === 0) {
                  for (const steeredId of pendingSteeredTasks) {
                    client.completeTask(token, steeredId, { output: "" }).catch((e) => {
                      log.debug(`steering: failed to complete steered task ${steeredId}`, e);
                    });
                  }
                  pendingSteeredTasks.clear();
                }
                turnState.markTurnCompleted();
                break;
              }
            }
          }
        } catch (err) {
          log.warn("steering: consumeParsedEvents error", { err: err instanceof Error ? err.message : String(err) });
        }
      };
      consumeParsedEvents().catch((err) => {
        log.error("steering: consumeParsedEvents unhandled error", { err: err instanceof Error ? err.message : String(err) });
      });
    }

    // Stalled recovery + startup timeout timer
    stalledRecoveryTimer = setInterval(() => {
      if (killed) return;

      // Startup timeout check on first tick
      if (!hasReceivedProgressEvent) {
        const startupResult = reduceApmStartupTimeoutTermination(apmState, {
          hasRuntimeProgressEvent: hasReceivedProgressEvent,
        });
        apmState = startupResult.nextState;
        if (startupResult.shouldTerminate) {
          log.warn("steering: startup timeout — no progress events received, killing agent");
          if (agentPid !== undefined) void killProcessTree(agentPid);
          return;
        }
      }

      // Stalled recovery check
      const staleForMs = progressState.ageMs();
      if (staleForMs > STALLED_THRESHOLD_MS && !progressState.isStale) {
        progressState.markStale();
      }
      const stalledResult = reduceApmStalledRecoveryTermination(apmState, {
        inboxLength: apmState.pendingMessages.length,
        staleForMs,
        staleThresholdMs: STALLED_THRESHOLD_MS,
        runtimeProgressIsStale: progressState.isStale,
        hasSession: !!earlySessionId,
        busyDeliveryMode: descriptor?.busyDeliveryMode ?? "none",
        hasDirectStdinRecoveryEvidence: false,
      });
      apmState = stalledResult.nextState;
      if (stalledResult.shouldTerminate) {
        log.warn(`steering: stalled recovery — agent stale for ${(staleForMs / 1000).toFixed(1)}s with ${apmState.pendingMessages.length} pending messages, killing`);
        if (agentPid !== undefined) void killProcessTree(agentPid);
      }
    }, STALLED_CHECK_INTERVAL_MS);

    // Start watching the mailbox for steered messages from daemon
    mailboxWatcher = watchInbox(
      agentBaseDir,
      task.contextKey,
      (seq, message) => {
        const sessionId = earlySessionId || "";
        if (notificationState.isDuplicateNotice(String(seq), sessionId)) {
          writeAck(agentBaseDir, task.contextKey!, seq);
          cleanupInboxFile(agentBaseDir, task.contextKey!, seq);
          return;
        }

        const busyMode = session.descriptor?.busyDeliveryMode;
        let delivered = false;

        if (busyMode === "direct" && session.send) {
          const result = session.send(message.text, turnState.isInTurn ? "busy" : "idle");
          if (result.ok) {
            notificationState.recordNoticeWritten(String(seq), sessionId, [{ id: String(seq) }]);
            writeAck(agentBaseDir, task.contextKey!, seq);
            delivered = true;
          } else {
            writeNack(agentBaseDir, task.contextKey!, seq, result.reason || "send failed");
          }
        } else if (busyMode === "gated") {
          const enqueueResult = reduceApmGatedEnqueue(apmState, message.text);
          apmState = enqueueResult.nextState;

          // Check if we can flush immediately
          if (turnState.canSteerBusy && session.send && apmState.pendingMessages.length > 0) {
            const readiness = reduceApmGatedFlushReadiness(apmState, {
              isGated: true,
              hasSession: !!earlySessionId,
              inboxLength: apmState.pendingMessages.length,
              reason: "enqueue",
            });
            if (readiness.shouldNotify) {
              let allSent = true;
              for (const msg of apmState.pendingMessages) {
                const sendResult = session.send(msg, "busy");
                if (!sendResult.ok) { allSent = false; break; }
              }
              if (allSent) {
                apmState = { ...apmState, pendingMessages: [] };
              }
            }
          }

          // Ack only if already flushed (no pending), otherwise defer ack to flush time
          if (apmState.pendingMessages.length === 0) {
            notificationState.recordNoticeWritten(String(seq), sessionId, [{ id: String(seq) }]);
            writeAck(agentBaseDir, task.contextKey!, seq);
          } else {
            // Track pending acks to write on successful flush
            pendingAcks.push({ seq, sessionId });
          }
          delivered = true;
        } else {
          writeNack(agentBaseDir, task.contextKey!, seq, "unsupported backend");
        }

        // Report steered task lifecycle to server
        if (delivered && message.taskId) {
          pendingSteeredTasks.add(message.taskId);
          client.startTask(token, message.taskId).catch((e) => {
            log.debug(`steering: failed to start steered task ${message.taskId}`, e);
          });
        }

        cleanupInboxFile(agentBaseDir, task.contextKey!, seq);
      },
    );

  }

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
        if (session.pid !== undefined) {
          // Reap the whole agent group, not just the leader, so MCP/tool
          // subprocesses don't orphan on an inactivity timeout.
          await killProcessTree(session.pid);
        }
        iter.return?.(undefined as never);
        break;
      }

      const iterResult = raceResult as IteratorResult<import("./types.js").AgentMessage>;
      if (iterResult.done) break;

      const msg = iterResult.value;
      seq++;

      if (msg.type === "tool-use") toolCount++;
      if (msg.type === "tool-result" && msg.output && msg.output.length > 500) {
        log.info(JSON.stringify({ role: "assistant", ...msg, output: msg.output.slice(0, 500) + `... (${msg.output.length} chars)` }));
      } else {
        log.info(JSON.stringify({ role: "assistant", ...msg }));
      }

      if (msg.type === "status" || msg.type === "log") continue;

      pendingMessages.push({
        seq,
        type: msg.type,
        tool: msg.tool,
        call_id: msg.callId,
        content: msg.type === "tool-result" ? "" : msg.content,
        input: msg.type === "tool-result" ? undefined : msg.input,
        output: msg.type === "tool-result" ? "" : msg.output,
      });

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
    if (flushTimer) clearInterval(flushTimer);
  }

  if (killed) return;

  // onKill stays installed across the result await so a kill landing here still
  // reaps the inner agent group; removed only once the result resolves.
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

  // Stop steering timers and clean up
  if (stalledRecoveryTimer) clearInterval(stalledRecoveryTimer);
  if (mailboxWatcher) {
    mailboxWatcher.stop();
    if (task.contextKey) cleanupSteeringDir(agentBaseDir, task.contextKey);
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

    // Update timeline entry to reflect failure
    const timelineDir = path.join(input.workspacesRoot, input.task.workspaceId, input.task.agentId, "workdir", ".context_timeline").replace(/\\/g, "/");
    updateEntry(timelineDir, input.task.id, (entry) => {
      entry.pid = null;
      entry.status = "failed";
      entry.errmsg = `session-runner crash: ${e}`;
    });

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

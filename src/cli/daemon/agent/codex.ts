import { spawn } from "child_process";
import { createInterface } from "readline";
import type { AgentBackend, AgentSession } from "./index.js";
import type { ExecOptions, AgentMessage, AgentResult } from "../types.js";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

type NotificationProtocol = "unknown" | "legacy" | "raw";

const RAW_DETECTION_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "thread/started",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
]);

/** Extract thread ID from a thread/start response. */
export function extractThreadID(response: unknown): string {
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    // Try nested result.thread.id first, then thread.id, then top-level id
    const thread =
      (r.result as Record<string, unknown> | undefined)?.thread ??
      (r.thread as Record<string, unknown> | undefined);
    if (thread && typeof thread === "object") {
      const id = (thread as Record<string, unknown>).id;
      if (typeof id === "string" && id) return id;
    }
    if (typeof r.id === "string" && r.id) return r.id;
  }
  return "";
}

export class CodexBackend implements AgentBackend {
  name = "codex";

  constructor(private cliPath: string) {}

  execute(prompt: string, options: ExecOptions): AgentSession {
    const proc = spawn(this.cliPath, ["app-server", "--listen", "stdio://", "--config", "sandbox_mode=danger-full-access"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      shell: process.platform === "win32",
      windowsHide: true,
    });

    if (!proc.pid) {
      const error = `Failed to start ${this.cliPath}: binary not found or not executable. Is 'codex' installed and on PATH?`;
      const failedResult: AgentResult = { status: "failed", output: "", error, durationMs: 0, sessionId: "" };
      const emptyMessages: AsyncIterable<AgentMessage> = { [Symbol.asyncIterator]() { return { async next() { return { value: undefined as unknown as AgentMessage, done: true }; } }; } };
      return { pid: undefined, messages: emptyMessages, sessionId: Promise.resolve(""), result: Promise.resolve(failedResult) };
    }

    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, options.timeout);
    }

    const startTime = Date.now();
    let requestId = 0;
    let lastOutput = "";
    let lastError = "";
    let resultStatus: AgentResult["status"] = "completed";
    let sessionId = "";
    let resolveSessionId: (id: string) => void;
    const sessionIdPromise = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });

    // Protocol detection state
    let notificationProtocol: NotificationProtocol = "unknown";

    // Turn lifecycle state
    let turnStarted = false;
    let turnDoneTriggered = false;
    let turnCompletedSuccessfully = false;
    let lastCompletedTurnId = "";
    let turnError = "";

    // Pending RPC callbacks
    const pendingRequests = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void }
    >();

    const messageQueue: AgentMessage[] = [];
    let messageResolve: (() => void) | null = null;
    let messageDone = false;

    const pushMessage = (msg: AgentMessage) => {
      messageQueue.push(msg);
      if (messageResolve) {
        const r = messageResolve;
        messageResolve = null;
        r();
      }
    };

    const writeStdin = (data: string) => {
      try {
        proc.stdin?.write(data + "\n");
      } catch {
        // stdin closed
      }
    };

    const sendRpc = (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      const id = ++requestId;
      const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
      writeStdin(JSON.stringify(msg));
      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
      });
    };

    const sendNotification = (method: string) => {
      const msg = { jsonrpc: "2.0" as const, method };
      writeStdin(JSON.stringify(msg));
    };

    const sendResponse = (id: number, result: unknown) => {
      const msg = { jsonrpc: "2.0" as const, id, result };
      writeStdin(JSON.stringify(msg));
    };

    /** Cancel all pending RPC requests. */
    const closeAllPending = (reason: string) => {
      for (const [, cb] of pendingRequests) {
        cb.reject(new Error(reason));
      }
      pendingRequests.clear();
    };

    const setTurnError = (msg: string) => {
      if (msg && !turnError) turnError = msg;
    };

    const triggerTurnDone = (aborted: boolean) => {
      if (turnDoneTriggered) return;
      turnDoneTriggered = true;
      resultStatus = aborted ? "aborted" : "completed";
      try { proc.stdin?.end(); } catch { /* already closed */ }
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    };

    const handleServerRequest = (msg: JsonRpcMessage) => {
      const method = msg.method!;
      const id = msg.id!;

      switch (method) {
        case "item/commandExecution/requestApproval":
        case "execCommandApproval":
        case "item/fileChange/requestApproval":
        case "applyPatchApproval":
          sendResponse(id, { decision: "accept" });
          break;
        default:
          sendResponse(id, {});
          break;
      }
    };

    const handleNotification = (msg: JsonRpcMessage) => {
      const method = msg.method!;
      const params = msg.params || {};

      // Legacy protocol detection
      if (method === "codex/event") {
        if (notificationProtocol === "raw") return; // locked to raw, ignore legacy
        notificationProtocol = "legacy";
        handleLegacyEvent(params);
        return;
      }

      // Raw protocol detection — these methods trigger detection
      if (RAW_DETECTION_METHODS.has(method)) {
        if (notificationProtocol === "legacy") return; // locked to legacy, ignore raw
        notificationProtocol = "raw";
      }

      // thread/status/changed and error are raw-only but NOT detection triggers
      if ((method === "thread/status/changed" || method === "error") && notificationProtocol === "legacy") {
        return;
      }

      // Subagent thread filtering: ignore notifications from threads other than ours
      const notifThreadId = params.threadId as string | undefined;
      if (sessionId && notifThreadId && notifThreadId !== sessionId) {
        return;
      }

      switch (method) {
        case "turn/started": {
          turnStarted = true;
          break;
        }

        case "turn/completed": {
          const turn = params.turn as Record<string, unknown> | undefined;
          const turnId = (turn?.id as string) || (params.turnId as string) || "";
          if (turnId && turnId === lastCompletedTurnId) return;
          if (turnId) lastCompletedTurnId = turnId;

          const status = (turn?.status as string) || (params.status as string) || "";
          if (status === "completed" || status === "finished") {
            turnCompletedSuccessfully = true;
            triggerTurnDone(false);
          } else if (status === "cancelled" || status === "aborted" || status === "interrupted") {
            triggerTurnDone(true);
          } else if (status === "error" || status === "failed") {
            const turnErr = turn?.error as Record<string, unknown> | undefined;
            setTurnError((turnErr?.message as string) || "codex turn failed");
            triggerTurnDone(false);
          }
          break;
        }

        case "error": {
          const errObj = params.error as Record<string, unknown> | undefined;
          const errMsg = (errObj?.message as string) || (params.message as string) || "";
          const willRetry = params.willRetry === true;
          if (errMsg && !willRetry) {
            setTurnError(errMsg);
          }
          break;
        }

        case "thread/status/changed": {
          const statusObj = params.status as Record<string, unknown> | string | undefined;
          const statusType = typeof statusObj === "object" && statusObj !== null
            ? (statusObj.type as string) || ""
            : (statusObj as string) || "";
          if (statusType === "idle" && turnStarted) {
            triggerTurnDone(false);
          }
          break;
        }

        case "item/started": {
          const item = params.item as Record<string, unknown> | undefined;
          if (!item) break;
          const itemType = item.type as string | undefined;

          if (itemType === "commandExecution") {
            pushMessage({
              type: "tool-use",
              tool: "exec_command",
              callId: item.id as string,
              input: item as Record<string, unknown>,
            });
          } else if (itemType === "fileChange") {
            pushMessage({
              type: "tool-use",
              tool: "patch_apply",
              callId: item.id as string,
              input: item as Record<string, unknown>,
            });
          }
          break;
        }

        case "item/completed": {
          const item = params.item as Record<string, unknown> | undefined;
          if (!item) break;
          const itemType = item.type as string | undefined;

          if (itemType === "commandExecution") {
            const output = (item.aggregatedOutput as string) || "";
            pushMessage({
              type: "tool-result",
              callId: item.id as string,
              output,
            });
          } else if (itemType === "fileChange") {
            pushMessage({
              type: "tool-result",
              callId: item.id as string,
              output: "",
            });
          } else if (itemType === "agentMessage") {
            const flatText = item.text as string | undefined;
            if (flatText) {
              pushMessage({ type: "text", content: flatText });
              lastOutput = flatText;
            } else {
              const content = item.content as
                | { type: string; text?: string }[]
                | undefined;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "output_text" || block.type === "text") {
                    if (block.text) {
                      pushMessage({ type: "text", content: block.text });
                      lastOutput = block.text;
                    }
                  }
                }
              }
            }
            const phase = item.phase as string | undefined;
            if (phase === "final_answer") {
              triggerTurnDone(false);
            }
          }
          break;
        }

        default: {
          pushMessage({
            type: "log",
            content: JSON.stringify(msg),
            level: "debug",
          });
        }
      }
    };

    const handleLegacyEvent = (params: Record<string, unknown>) => {
      const eventType = params.type as string | undefined;
      if (!eventType) return;

      switch (eventType) {
        case "task_started":
          break;

        case "agent_message": {
          const text = (params.text as string) || (params.message as string) || "";
          if (text) {
            pushMessage({ type: "text", content: text });
            lastOutput = text;
          }
          break;
        }

        case "exec_command_begin":
          pushMessage({
            type: "tool-use",
            tool: "exec_command",
            callId: params.id as string,
            input: params as Record<string, unknown>,
          });
          break;

        case "exec_command_end":
          pushMessage({
            type: "tool-result",
            callId: params.id as string,
            output: (params.output as string) || "",
          });
          break;

        case "patch_apply_begin":
          pushMessage({
            type: "tool-use",
            tool: "patch_apply",
            callId: params.id as string,
            input: params as Record<string, unknown>,
          });
          break;

        case "patch_apply_end":
          pushMessage({
            type: "tool-result",
            callId: params.id as string,
            output: (params.output as string) || "",
          });
          break;

        case "task_complete": {
          const output = params.output as string | undefined;
          if (output) lastOutput = output;
          triggerTurnDone(false);
          break;
        }

        case "turn_aborted":
          triggerTurnDone(true);
          break;
      }
    };

    const resultPromise = new Promise<AgentResult>((resolve) => {
      const stderrChunks: string[] = [];

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      const rl = createInterface({ input: proc.stdout! });

      rl.on("line", (line: string) => {
        if (!line.trim()) return;

        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          pushMessage({ type: "log", content: line, level: "debug" });
          return;
        }

        // Route: server request (has both id AND method)
        if (msg.id !== undefined && msg.method) {
          handleServerRequest(msg);
          return;
        }

        // Route: notification (has method, no id)
        if (msg.method && msg.id === undefined) {
          handleNotification(msg);
          return;
        }

        // Route: response (has id, no method) — both success and error
        if (msg.id !== undefined && !msg.method) {
          const pending = pendingRequests.get(msg.id);
          if (pending) {
            pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
          return;
        }

        // Fallback
        pushMessage({
          type: "log",
          content: JSON.stringify(msg),
          level: "debug",
        });
      });

      // Handshake: initialize → initialized → thread/start → turn/start
      const startHandshake = async () => {
        try {
          // 1. Initialize
          await sendRpc("initialize", {
            clientInfo: {
              name: "alook-daemon",
              title: "Alook Agent SDK",
              version: "0.1.0",
            },
            capabilities: { experimentalApi: true },
          });

          // 2. Send initialized notification
          sendNotification("initialized");

          // 3. Start or resume thread
          let threadResponse: unknown;
          if (options.resumeSessionId) {
            // thread/resume reopens an existing thread by ID
            threadResponse = await sendRpc("thread/resume", {
              threadId: options.resumeSessionId,
              ...(options.model ? { model: options.model } : {}),
            });
            sessionId = options.resumeSessionId;
          } else {
            // thread/start creates a new thread
            const threadParams: Record<string, unknown> = {
              cwd: options.cwd,
              sandboxPolicy: { type: "dangerFullAccess" },
              approvalPolicy: "never",
              persistExtendedHistory: true,
              experimentalRawEvents: false,
            };
            if (options.model) {
              threadParams.model = options.model;
            }
            threadResponse = await sendRpc("thread/start", threadParams);
            sessionId = extractThreadID(threadResponse);
          }

          resolveSessionId(sessionId);

          // 5. Send turn/start with the prompt
          await sendRpc("turn/start", {
            threadId: sessionId,
            input: [{ type: "text", text: prompt }],
            sandboxPolicy: { type: "dangerFullAccess" },
            approvalPolicy: "never",
          });
        } catch (err) {
          const errMsg =
            err instanceof Error ? err.message : "handshake failed";
          lastError = errMsg;
          resultStatus = "failed";
          pushMessage({ type: "error", content: errMsg });
        }
      };

      startHandshake();

      proc.on("error", (err: Error) => {
        resultStatus = "failed";
        lastError = `spawn error: ${err.message}`;
        closeAllPending("spawn error");
        resolveSessionId(sessionId);
        messageDone = true;
        if (messageResolve) {
          const r = messageResolve;
          messageResolve = null;
          r();
        }
        resolve({
          status: "failed",
          output: "",
          error: lastError,
          durationMs: Date.now() - startTime,
          sessionId,
        });
      });

      proc.on("close", (code: number | null) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);

        closeAllPending("process closed");

        if (timedOut) {
          resultStatus = "timeout";
        } else if (code !== 0 && resultStatus === "completed" && !turnCompletedSuccessfully) {
          // If agent already produced output, treat as completed despite non-zero exit
          // (e.g. MCP transport errors can crash the process after a successful response)
          if (!lastOutput) {
            resultStatus = "failed";
          }
        }

        const stderr = stderrChunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
        if (stderr && !lastError) {
          lastError = stderr;
        }

        if (turnError) {
          resultStatus = "failed";
          lastError = turnError;
        }

        // Resolve sessionId promise (fallback if handshake never completed)
        resolveSessionId(sessionId);

        messageDone = true;
        if (messageResolve) {
          const r = messageResolve;
          messageResolve = null;
          r();
        }

        resolve({
          status: resultStatus,
          output: lastOutput,
          error: lastError,
          durationMs: Date.now() - startTime,
          sessionId,
        });
      });
    });

    const messages: AsyncIterable<AgentMessage> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentMessage>> {
            while (messageQueue.length === 0 && !messageDone) {
              await new Promise<void>((resolve) => {
                messageResolve = resolve;
              });
            }
            if (messageQueue.length > 0) {
              return { value: messageQueue.shift()!, done: false };
            }
            return { value: undefined as unknown as AgentMessage, done: true };
          },
        };
      },
    };

    return { pid: proc.pid, messages, sessionId: sessionIdPromise, result: resultPromise };
  }
}

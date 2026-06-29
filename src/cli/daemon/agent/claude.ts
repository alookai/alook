import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import type { AgentBackend, AgentSession } from "./index.js";
import type {
  ExecOptions,
  AgentMessage,
  AgentResult,
  ParsedEvent,
  StdinMode,
  DriverLifecycle,
  BusyDeliveryMode,
  EncodeOpts,
} from "../types.js";
import { killProcessTree } from "../kill-tree.js";

export class ClaudeBackend implements AgentBackend {
  name = "claude";
  lifecycle: DriverLifecycle = { kind: "persistent", stdin: "gated", inFlightWake: "queue" };
  busyDeliveryMode: BusyDeliveryMode = "gated";
  supportsStdinNotification = true;

  constructor(private cliPath: string) {}

  parseLine(line: string): ParsedEvent[] {
    if (!line.trim()) return [];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return [{ kind: "log", content: line, level: "debug" }];
    }

    const events: ParsedEvent[] = [];
    const eventType = event.type as string | undefined;

    switch (eventType) {
      case "assistant": {
        const message = event.message as Record<string, unknown> | undefined;
        if (!message) break;
        const content = message.content as
          | { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }[]
          | undefined;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === "text") {
            events.push({ kind: "text", text: block.text || "" });
          } else if (block.type === "thinking") {
            events.push({ kind: "thinking", text: block.text || "" });
          } else if (block.type === "tool_use") {
            events.push({ kind: "tool_call", name: block.name || "", input: block.input, callId: block.id });
          }
        }
        break;
      }

      case "result": {
        const result = event.result as string | undefined;
        const isError = event.is_error as boolean | undefined;
        if (isError) {
          events.push({ kind: "error", message: result || "unknown error" });
        }
        const resultSessionId = event.session_id as string | undefined;
        events.push({ kind: "turn_end", sessionId: resultSessionId || undefined });
        const usage = event.usage as Record<string, unknown> | undefined;
        if (usage || event.total_cost_usd != null) {
          events.push({
            kind: "telemetry",
            name: "token_usage",
            source: "claude_result_usage",
            usageKind: "per_turn",
            attrs: {
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
              cachedInputTokens: usage?.cache_read_input_tokens,
              cacheCreationInputTokens: usage?.cache_creation_input_tokens,
              totalCostUsd: event.total_cost_usd,
              durationMs: event.duration_ms,
              durationApiMs: event.duration_api_ms,
              numTurns: event.num_turns,
              resultSubtype: event.subtype,
              resultIsError: event.is_error,
              serviceTier: usage?.service_tier,
            },
          });
        }
        break;
      }

      case "tool_result": {
        const toolUseId = event.tool_use_id as string | undefined;
        const content = event.content as string | undefined;
        events.push({ kind: "tool_output", callId: toolUseId, output: content });
        break;
      }

      case "system": {
        const subtype = event.subtype as string | undefined;
        if (subtype === "init") {
          const sid = event.session_id as string | undefined;
          events.push({ kind: "session_init", sessionId: sid || "" });
        } else if (subtype === "context_pruning" || subtype === "compaction") {
          events.push({ kind: "compaction_started" });
        } else if (subtype === "compaction_finished" || subtype === "context_pruning_finished") {
          events.push({ kind: "compaction_finished" });
        } else if (subtype === "status" || subtype === "stream_event") {
          events.push({
            kind: "internal_progress",
            source: "claude_system",
            itemType: subtype,
            payloadBytes: line.length,
          });
        }
        break;
      }

      case "control_request": {
        const requestId = event.request_id as string | undefined;
        if (requestId) {
          events.push({ kind: "permission_request", requestId, payload: event.payload });
        }
        break;
      }

      default: {
        events.push({ kind: "log", content: line, level: "debug" });
      }
    }

    return events;
  }

  encodeStdinMessage(text: string, mode: StdinMode, opts?: EncodeOpts): string | null {
    const msg: Record<string, unknown> = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
    if (opts?.sessionId) {
      msg.session_id = opts.sessionId;
    }
    return JSON.stringify(msg);
  }

  execute(prompt: string, options: ExecOptions): AgentSession {
    // When steering is enabled, use --input-format stream-json and deliver
    // the initial prompt via stdin JSON write instead of -p. This allows
    // mid-turn message injection on the same stdin pipe. Without steering,
    // use the normal -p flag (--input-format stream-json + -p causes a hang).
    const useStdinPrompt = options.steeringEnabled === true;

    const args: string[] = [];
    if (!useStdinPrompt) {
      args.push("-p", prompt);
    }
    args.push(
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    );
    if (useStdinPrompt) {
      args.push("--input-format", "stream-json");
    }

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.maxTurns) {
      args.push("--max-turns", String(options.maxTurns));
    }
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }

    const proc = spawn(this.cliPath, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      shell: process.platform === "win32",
      windowsHide: true,
      // POSIX: own process group (pgid === pid) so the session-runner can reap
      // the CLI *and* its tool/MCP subprocesses via a group kill. No unref() —
      // we keep the handle for stdio streaming and the result promise.
      detached: process.platform !== "win32",
    });

    if (!proc.pid) {
      const error = `Failed to start ${this.cliPath}: binary not found or not executable. Is 'claude' installed and on PATH?`;
      const failedResult: AgentResult = { status: "failed", output: "", error, durationMs: 0, sessionId: "" };
      const emptyMessages: AsyncIterable<AgentMessage> = { [Symbol.asyncIterator]() { return { async next() { return { value: undefined as unknown as AgentMessage, done: true }; } }; } };
      return { pid: undefined, messages: emptyMessages, sessionId: Promise.resolve(""), result: Promise.resolve(failedResult) };
    }

    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        // Reap the whole group (CLI + tool/MCP subprocesses), not just the leader.
        if (proc.pid !== undefined) void killProcessTree(proc.pid);
      }, options.timeout);
    }

    const startTime = Date.now();
    let lastSessionId = "";
    let lastOutput = "";
    let lastError = "";
    let resultStatus: AgentResult["status"] = "completed";
    let resolveSessionId: (id: string) => void;
    const sessionIdPromise = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });

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

    // ParsedEvent queue — parallel stream for steering layer observation
    const parsedEventQueue: ParsedEvent[] = [];
    let parsedEventResolve: (() => void) | null = null;
    let parsedEventDone = false;

    const pushParsedEvent = (evt: ParsedEvent) => {
      parsedEventQueue.push(evt);
      if (parsedEventResolve) {
        const r = parsedEventResolve;
        parsedEventResolve = null;
        r();
      }
    };

    // Serialized stdin write queue — prevents interleaved writes
    // from concurrent control_response and steering messages.
    const stdinWriteQueue: string[] = [];
    let stdinDraining = false;

    const enqueueStdinWrite = (data: string) => {
      stdinWriteQueue.push(data);
      drainStdinQueue();
    };

    const drainStdinQueue = () => {
      if (stdinDraining) return;
      stdinDraining = true;
      while (stdinWriteQueue.length > 0) {
        const line = stdinWriteQueue.shift()!;
        try {
          proc.stdin?.write(line + "\n");
        } catch {
          // stdin closed
        }
      }
      stdinDraining = false;
    };

    const resultPromise = new Promise<AgentResult>((resolve) => {
      const stderrChunks: string[] = [];

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      const rl = createInterface({ input: proc.stdout! });

      // When steering mode, deliver the initial prompt via stdin JSON
      if (useStdinPrompt) {
        const initialMsg = JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        });
        enqueueStdinWrite(initialMsg);
      }

      rl.on("line", (line: string) => {
        if (!line.trim()) return;

        // Emit ParsedEvents for steering layer
        const parsed = this.parseLine(line);
        for (const pe of parsed) pushParsedEvent(pe);

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          pushMessage({ type: "log", content: line, level: "debug" });
          return;
        }

        const eventType = event.type as string | undefined;

        switch (eventType) {
          case "assistant": {
            const message = event.message as Record<string, unknown> | undefined;
            if (!message) break;
            const content = message.content as
              | { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }[]
              | undefined;
            if (!Array.isArray(content)) break;

            for (const block of content) {
              if (block.type === "text") {
                lastOutput = block.text || "";
                pushMessage({ type: "text", content: block.text });
              } else if (block.type === "thinking") {
                pushMessage({ type: "thinking", content: block.text });
              } else if (block.type === "tool_use") {
                pushMessage({
                  type: "tool-use",
                  tool: block.name,
                  callId: block.id,
                  input: block.input,
                });
              }
            }
            break;
          }

          case "result": {
            const result = event.result as string | undefined;
            const sessionId = event.session_id as string | undefined;
            if (result) lastOutput = result;
            if (sessionId) lastSessionId = sessionId;

            const isError = event.is_error as boolean | undefined;
            if (isError) {
              resultStatus = "failed";
              lastError = result || "unknown error";
            }

            // In steering mode (--input-format stream-json), Claude keeps the
            // process alive waiting for more stdin. Defer stdin close to allow
            // the steering layer to flush pending messages on turn_end first.
            // The session-runner calls closeStdin() after the flush completes.
            if (useStdinPrompt) {
              setTimeout(() => {
                try { proc.stdin?.end(); } catch { /* already closed */ }
              }, 100);
            }
            break;
          }

          case "tool_result": {
            const content = event.content as string | undefined;
            const toolUseId = event.tool_use_id as string | undefined;
            pushMessage({
              type: "tool-result",
              callId: toolUseId,
              output: content,
            });
            break;
          }

          case "system": {
            const subtype = event.subtype as string | undefined;
            if (subtype === "init") {
              const sid = event.session_id as string | undefined;
              if (sid) {
                lastSessionId = sid;
                resolveSessionId(sid);
              }
            }
            break;
          }

          case "control_request": {
            handleControlRequest(proc, event, enqueueStdinWrite);
            break;
          }

          default: {
            pushMessage({
              type: "log",
              content: line,
              level: "debug",
            });
          }
        }
      });

      proc.on("error", (err: Error) => {
        resultStatus = "failed";
        lastError = `spawn error: ${err.message}`;
        resolveSessionId(lastSessionId);
        messageDone = true;
        parsedEventDone = true;
        if (messageResolve) {
          const r = messageResolve;
          messageResolve = null;
          r();
        }
        if (parsedEventResolve) {
          const r = parsedEventResolve;
          parsedEventResolve = null;
          r();
        }
        resolve({
          status: "failed",
          output: "",
          error: lastError,
          durationMs: Date.now() - startTime,
          sessionId: lastSessionId,
        });
      });

      proc.on("close", (code: number | null) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);

        if (timedOut) {
          resultStatus = "timeout";
        } else if (code !== 0 && resultStatus === "completed") {
          resultStatus = "failed";
        }

        const stderr = stderrChunks.join("");
        if (stderr && !lastError) {
          lastError = stderr;
        }

        // Resolve sessionId promise (fallback if system/init never fired)
        resolveSessionId(lastSessionId);

        messageDone = true;
        parsedEventDone = true;
        if (messageResolve) {
          const r = messageResolve;
          messageResolve = null;
          r();
        }
        if (parsedEventResolve) {
          const r = parsedEventResolve;
          parsedEventResolve = null;
          r();
        }

        resolve({
          status: resultStatus,
          output: lastOutput,
          error: lastError,
          durationMs: Date.now() - startTime,
          sessionId: lastSessionId,
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

    const parsedEvents: AsyncIterable<ParsedEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<ParsedEvent>> {
            while (parsedEventQueue.length === 0 && !parsedEventDone) {
              await new Promise<void>((resolve) => {
                parsedEventResolve = resolve;
              });
            }
            if (parsedEventQueue.length > 0) {
              return { value: parsedEventQueue.shift()!, done: false };
            }
            return { value: undefined as unknown as ParsedEvent, done: true };
          },
        };
      },
    };

    const send = (text: string, mode: StdinMode): { ok: boolean; reason?: string } => {
      const encoded = this.encodeStdinMessage(text, mode, { sessionId: lastSessionId || undefined });
      if (!encoded) return { ok: false, reason: "encoding failed" };
      if (!proc.stdin || proc.stdin.destroyed) return { ok: false, reason: "stdin closed" };
      enqueueStdinWrite(encoded);
      return { ok: true };
    };

    const descriptor = {
      lifecycle: this.lifecycle,
      busyDeliveryMode: this.busyDeliveryMode,
      supportsStdinNotification: this.supportsStdinNotification,
    };

    const closeStdin = () => {
      try {
        if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
      } catch { /* already closed */ }
    };

    return { pid: proc.pid, messages, parsedEvents, sessionId: sessionIdPromise, result: resultPromise, send, closeStdin, descriptor };
  }
}

function handleControlRequest(
  proc: ChildProcess,
  event: Record<string, unknown>,
  enqueueStdinWrite?: (data: string) => void,
): void {
  const requestId = event.request_id as string | undefined;
  if (!requestId) return;

  let updatedInput: unknown = undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload) {
    const input = payload.input;
    if (typeof input === "string") {
      try {
        updatedInput = JSON.parse(input);
      } catch {
        updatedInput = input;
      }
    } else if (input !== undefined) {
      updatedInput = input;
    }
  }

  const approval = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "allow",
        updatedInput,
      },
    },
  });

  if (enqueueStdinWrite) {
    enqueueStdinWrite(approval);
  } else {
    try {
      proc.stdin?.write(approval + "\n");
    } catch {
      // stdin may be closed
    }
  }
}

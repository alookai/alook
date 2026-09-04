import { spawn } from "child_process";
import { createInterface } from "readline";
import type { AgentBackend, AgentSession } from "./index.js";
import type {
  ExecOptions,
  AgentMessage,
  AgentResult,
  ParsedEvent,
  DriverLifecycle,
  BusyDeliveryMode,
} from "../types.js";
import { killProcessTree } from "../kill-tree.js";
import { quoteWinArg, quoteWinArgs } from "./win-quote.js";

export class OpenCodeBackend implements AgentBackend {
  name = "opencode";
  lifecycle: DriverLifecycle = { kind: "per_turn", inFlightWake: "coalesce_into_pending" };
  busyDeliveryMode: BusyDeliveryMode = "none";
  supportsStdinNotification = false;

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
    const part = event.part as Record<string, unknown> | undefined;

    const eventSessionId = (event.sessionID as string) || (event.session_id as string);

    switch (eventType) {
      case "session": {
        const sessionId = event.session_id as string | undefined;
        if (sessionId) events.push({ kind: "session_init", sessionId });
        break;
      }

      case "message": {
        const role = event.role as string | undefined;
        const content = event.content as string | undefined;
        if (role === "assistant" && content) {
          events.push({ kind: "text", text: content });
        }
        break;
      }

      case "text": {
        const text = (part?.text as string) || (event.content as string) || "";
        if (text) events.push({ kind: "text", text });
        break;
      }

      case "thinking": {
        const content = (part?.thinking as string) || (event.content as string) || "";
        events.push({ kind: "thinking", text: content });
        break;
      }

      case "tool_call":
        events.push({
          kind: "tool_call",
          name: (event.name as string) || (part?.name as string) || "",
          callId: (event.call_id as string) || (part?.id as string) || "",
          input: (event.input as Record<string, unknown>) || (part?.input as Record<string, unknown>),
        });
        break;

      case "tool_result":
        events.push({
          kind: "tool_output",
          callId: (event.call_id as string) || (part?.id as string) || "",
          output: (event.output as string) || (part?.output as string) || "",
        });
        break;

      case "error": {
        const content = (event.message as string) || (event.content as string) || (part?.error as string) || "";
        events.push({ kind: "error", message: content });
        events.push({ kind: "turn_end" });
        break;
      }

      case "step_start":
        break;

      case "step_finish": {
        const reason = part?.reason as string | undefined;
        if (reason === "stop" || reason === "end_turn") {
          events.push({ kind: "turn_end" });
        }
        break;
      }

      case "done":
      case "complete": {
        const status = event.status as string | undefined;
        if (status === "error" || status === "failed") {
          const output = event.output as string | undefined;
          events.push({ kind: "error", message: output || "task failed" });
        }
        events.push({ kind: "turn_end" });
        break;
      }

      default:
        events.push({ kind: "log", content: line, level: "debug" });
    }

    // Attach session info if available as first event
    if (eventSessionId && events.length > 0 && events[0].kind !== "session_init") {
      events.unshift({ kind: "session_init", sessionId: eventSessionId });
    }

    return events;
  }

  encodeStdinMessage(): string | null {
    return null;
  }

  execute(prompt: string, options: ExecOptions): AgentSession {
    const args = ["run", "--format", "json", "--dir", options.cwd];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.resumeSessionId) {
      args.push("--session", options.resumeSessionId);
    }

    // User prompt as positional argument (no flag)
    args.push(prompt);

    // spawn({ shell: true }) on Windows joins args with spaces without quoting
    // — see win-quote.ts. Pre-quote so args with spaces (workspace paths under
    // C:\Users\<name with space>\.alook\...) survive cmd.exe parsing.
    const isWin = process.platform === "win32";
    const spawnCmd = isWin ? quoteWinArg(this.cliPath) : this.cliPath;
    const spawnArgs = isWin ? quoteWinArgs(args) : args;

    const proc = spawn(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env, OPENCODE_PERMISSION: '{"*":"allow"}' },
      shell: isWin,
      windowsHide: true,
      // POSIX: own process group (pgid === pid) so the session-runner can reap
      // the CLI *and* its tool subprocesses via a group kill. No unref() — we
      // keep the handle for stdio streaming and the result promise.
      detached: process.platform !== "win32",
    });

    if (!proc.pid) {
      const error = `Failed to start ${this.cliPath}: binary not found or not executable. Is 'opencode' installed and on PATH?`;
      const failedResult: AgentResult = { status: "failed", output: "", error, durationMs: 0, sessionId: "" };
      const emptyMessages: AsyncIterable<AgentMessage> = { [Symbol.asyncIterator]() { return { async next() { return { value: undefined as unknown as AgentMessage, done: true }; } }; } };
      return { pid: undefined, messages: emptyMessages, sessionId: Promise.resolve(""), result: Promise.resolve(failedResult) };
    }

    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        // Reap the whole group (CLI + tool subprocesses), not just the leader.
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

    let turnDoneTriggered = false;
    const turnDone = () => {
      if (turnDoneTriggered) return;
      turnDoneTriggered = true;
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    };

    const messageQueue: AgentMessage[] = [];
    let messageResolve: (() => void) | null = null;
    let messageDone = false;

    const parsedEventQueue: ParsedEvent[] = [];
    let parsedEventResolve: (() => void) | null = null;
    let parsedEventDone = false;

    const pushMessage = (msg: AgentMessage) => {
      messageQueue.push(msg);
      if (messageResolve) {
        const r = messageResolve;
        messageResolve = null;
        r();
      }
    };

    const pushParsedEvent = (evt: ParsedEvent) => {
      parsedEventQueue.push(evt);
      if (parsedEventResolve) {
        const r = parsedEventResolve;
        parsedEventResolve = null;
        r();
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
        const part = event.part as Record<string, unknown> | undefined;

        // Extract sessionID from any event (v1.14+ format)
        const eventSessionId = (event.sessionID as string) || (event.session_id as string);
        if (eventSessionId && !lastSessionId) {
          lastSessionId = eventSessionId;
          resolveSessionId(eventSessionId);
        }

        switch (eventType) {
          case "session": {
            const sessionId = event.session_id as string | undefined;
            if (sessionId) {
              lastSessionId = sessionId;
              resolveSessionId(sessionId);
            }
            break;
          }

          case "message": {
            const role = event.role as string | undefined;
            const content = event.content as string | undefined;
            if (role === "assistant" && content) {
              lastOutput = content;
              pushMessage({ type: "text", content });
            }
            break;
          }

          // v1.14+ format: { type: "text", part: { text: "..." } }
          case "text": {
            const text = (part?.text as string) || (event.content as string) || "";
            if (text) {
              lastOutput = text;
              pushMessage({ type: "text", content: text });
            }
            break;
          }

          case "thinking": {
            const content = (part?.thinking as string) || (event.content as string) || "";
            pushMessage({ type: "thinking", content });
            break;
          }

          case "tool_call": {
            pushMessage({
              type: "tool-use",
              tool: (event.name as string) || (part?.name as string) || "",
              callId: (event.call_id as string) || (part?.id as string) || "",
              input: (event.input as Record<string, unknown>) || (part?.input as Record<string, unknown>),
            });
            break;
          }

          case "tool_result": {
            pushMessage({
              type: "tool-result",
              callId: (event.call_id as string) || (part?.id as string) || "",
              output: (event.output as string) || (part?.output as string) || "",
            });
            break;
          }

          case "error": {
            const content = (event.message as string) || (event.content as string) || (part?.error as string) || "";
            lastError = content;
            // Mark the run failed (matches codex.ts + the done/spawn-error branches
            // below). Without this the run ends "completed", failTask never runs,
            // no assistant error message is persisted, and the error is lost on
            // reload — it only ever showed via the live task.messages broadcast.
            resultStatus = "failed";
            pushMessage({ type: "error", content });
            turnDone();
            break;
          }

          // v1.14+ signals
          case "step_start": {
            break;
          }

          case "step_finish": {
            const reason = part?.reason as string | undefined;
            if (reason === "stop" || reason === "end_turn") {
              turnDone();
            }
            break;
          }

          case "done":
          case "complete": {
            const output = event.output as string | undefined;
            const status = event.status as string | undefined;
            const sessionId = event.session_id as string | undefined;

            if (output) lastOutput = output;
            if (sessionId) lastSessionId = sessionId;

            if (status === "error" || status === "failed") {
              resultStatus = "failed";
              if (!lastError) lastError = output || "task failed";
            }
            turnDone();
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
        rl.close();

        if (timedOut) {
          resultStatus = "timeout";
        } else if (code !== 0 && resultStatus === "completed" && !turnDoneTriggered) {
          if (!lastOutput) {
            resultStatus = "failed";
          }
        }

        const stderr = stderrChunks.join("");
        if (stderr && !lastError) {
          lastError = stderr;
        }

        // Resolve sessionId promise (fallback if session event never fired)
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

    const send = (): { ok: boolean; reason?: string } => {
      return { ok: false, reason: "unsupported" };
    };

    const descriptor = {
      lifecycle: this.lifecycle,
      busyDeliveryMode: this.busyDeliveryMode,
      supportsStdinNotification: this.supportsStdinNotification,
    };

    return { pid: proc.pid, messages, parsedEvents, sessionId: sessionIdPromise, result: resultPromise, send, descriptor };
  }
}

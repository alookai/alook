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

export class HermesBackend implements AgentBackend {
  name = "hermes";
  lifecycle: DriverLifecycle = {
    kind: "per_turn",
    inFlightWake: "coalesce_into_pending",
  };
  busyDeliveryMode: BusyDeliveryMode = "none";
  supportsStdinNotification = false;

  constructor(private cliPath: string) {}

  parseLine(line: string): ParsedEvent[] {
    if (!line.trim()) return [];

    const events: ParsedEvent[] = [];

    // Hermes session_id line: "session_id: 20260705_140413_1a7e0b"
    const sessionMatch = line.match(/^session_id:\s*(\S+)/);
    if (sessionMatch) {
      events.push({
        kind: "session_init",
        sessionId: sessionMatch[1],
      });
      return events;
    }

    // Regular text output
    events.push({ kind: "text", text: line });
    return events;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  encodeStdinMessage(_text: string, _mode: string): string | null {
    return null;
  }

  execute(prompt: string, options: ExecOptions): AgentSession {
    const args = ["chat", "-Q", "-q", prompt];

    if (options.model) {
      args.unshift("-m", options.model);
    }

    const proc = spawn(this.cliPath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      shell: process.platform === "win32",
      windowsHide: true,
      // POSIX: own process group so session-runner can reap the CLI
      // and its tool subprocesses via a group kill.
      detached: process.platform !== "win32",
    });

    if (!proc.pid) {
      const error = `Failed to start ${this.cliPath}: binary not found or not executable. Is 'hermes' installed and on PATH?`;
      const failedResult: AgentResult = {
        status: "failed",
        output: "",
        error,
        durationMs: 0,
        sessionId: "",
      };
      const emptyMessages: AsyncIterable<AgentMessage> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                value: undefined as unknown as AgentMessage,
                done: true,
              };
            },
          };
        },
      };
      return {
        pid: undefined,
        messages: emptyMessages,
        sessionId: Promise.resolve(""),
        result: Promise.resolve(failedResult),
      };
    }

    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
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

        // Parse line for events (session_init, text)
        const parsed = this.parseLine(line);
        for (const pe of parsed) {
          pushParsedEvent(pe);

          if (pe.kind === "session_init") {
            lastSessionId = pe.sessionId;
            resolveSessionId(pe.sessionId);
            pushMessage({
              type: "log",
              content: line,
              level: "info",
            });
          } else if (pe.kind === "text") {
            lastOutput = pe.text;
            pushMessage({ type: "text", content: pe.text });
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
          if (!lastOutput) {
            resultStatus = "failed";
          }
        }

        const stderr = stderrChunks.join("");
        if (stderr && !lastError) {
          lastError = stderr;
        }

        // Resolve sessionId promise (fallback if session_id line never appeared)
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
            return {
              value: undefined as unknown as AgentMessage,
              done: true,
            };
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
            return {
              value: undefined as unknown as ParsedEvent,
              done: true,
            };
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

    return {
      pid: proc.pid,
      messages,
      parsedEvents,
      sessionId: sessionIdPromise,
      result: resultPromise,
      send,
      descriptor,
    };
  }
}

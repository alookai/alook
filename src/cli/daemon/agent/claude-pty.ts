/**
 * ClaudePTYBackend — runs Claude Code in an interactive PTY session.
 *
 * Instead of `claude -p` (programmatic mode, billed as Agent SDK usage),
 * this backend spawns an interactive Claude TUI inside a pseudo-terminal,
 * writes the prompt as if a human typed it, and reads structured events
 * from the session JSONL file that Claude Code persists automatically.
 *
 * This preserves full streaming of text, thinking, tool-use, and tool-result
 * events while being classified as "interactive" usage by Anthropic.
 */

import { openSync, readSync, closeSync, statSync, existsSync, writeSync as fsWriteSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { handleTerminalQueries, stripAnsi } from "./ansi-scanner.js";
import type { AgentBackend, AgentSession } from "./index.js";
import type { ExecOptions, AgentMessage, AgentResult } from "../types.js";

/**
 * Access Bun APIs at runtime without a static `import from "bun"`,
 * which would break the bundler when target !== "bun".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BunRuntime = globalThis as any;

interface BunProc {
  pid: number;
  stdin: unknown;
  exited: Promise<number>;
  kill(): void;
}

/** Safely write to a Bun subprocess stdin (which may be number | FileSink). */
function writeToStdin(proc: BunProc | undefined, data: string): void {
  if (!proc?.stdin) return;
  try {
    if (typeof proc.stdin === "number") {
      // Terminal mode may expose stdin as a raw fd
      fsWriteSync(proc.stdin, data);
    } else if (typeof proc.stdin === "object" && "write" in (proc.stdin as object)) {
      (proc.stdin as { write(data: string): void }).write(data);
    }
  } catch {
    // stdin may be closed
  }
}

/** How long to wait for PTY output to stabilize before considering TUI ready. */
const QUIESCENT_MS = parseInt(process.env.ALOOK_PTY_QUIESCENT_MS || "500", 10);
/** Maximum time to wait for TUI to become ready. */
const READY_TIMEOUT_MS = parseInt(process.env.ALOOK_PTY_READY_TIMEOUT_MS || "30000", 10);
/** Interval for polling session JSONL for new events. */
const JSONL_POLL_MS = 200;

export class ClaudePTYBackend implements AgentBackend {
  name = "claude-pty";

  constructor(private cliPath: string) {}

  execute(prompt: string, options: ExecOptions): AgentSession {
    const sessionId = options.resumeSessionId || randomUUID();
    const startTime = Date.now();

    // Build args for interactive mode (no -p flag)
    const args: string[] = [];

    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    } else {
      args.push("--session-id", sessionId);
    }

    args.push("--permission-mode", "bypassPermissions");

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.maxTurns) {
      args.push("--max-turns", String(options.maxTurns));
    }

    // State
    let lastDataTime = 0;
    let tuiReady = false;
    let promptWritten = false;
    let lastOutput = "";
    let lastError = "";
    let resultStatus: AgentResult["status"] = "completed";
    let timedOut = false;
    let jsonlByteOffset = 0;
    let proc: BunProc | undefined;

    // Message queue (same pattern as ClaudeBackend)
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

    // Session ID promise
    let resolveSessionId: (id: string) => void;
    const sessionIdPromise = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });

    // Result promise
    const resultPromise = new Promise<AgentResult>((resolveResult) => {
      const decoder = new TextDecoder();
      let outputBuffer = "";

      // --- Timeout handling ---
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      if (options.timeout) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          proc?.kill();
        }, options.timeout);
      }

      // --- JSONL watcher ---
      let jsonlPath: string | null = null;
      let jsonlPollTimer: ReturnType<typeof setInterval> | undefined;

      function findJsonlPath(cwd: string, sid: string): string {
        // Claude Code encodes cwd by replacing / with -
        const encoded = cwd.replace(/\//g, "-");
        return join(
          process.env.HOME || "~",
          ".claude",
          "projects",
          encoded,
          "sessions",
          `${sid}.jsonl`,
        );
      }

      function processJsonlLines() {
        if (!jsonlPath || !existsSync(jsonlPath)) return;

        let fileSize: number;
        try {
          fileSize = statSync(jsonlPath).size;
        } catch {
          return;
        }
        if (fileSize <= jsonlByteOffset) return;

        let chunk: string;
        try {
          const fd = openSync(jsonlPath, "r");
          const buf = Buffer.alloc(fileSize - jsonlByteOffset);
          readSync(fd, buf, 0, buf.length, jsonlByteOffset);
          closeSync(fd);
          jsonlByteOffset = fileSize;
          chunk = buf.toString("utf-8");
        } catch {
          return;
        }

        const newLines = chunk.split("\n").filter(Boolean);

        for (const line of newLines) {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          const eventType = event.type as string | undefined;

          if (eventType === "assistant") {
            const message = event.message as Record<string, unknown> | undefined;
            if (!message) continue;

            const content = message.content as
              | { type: string; text?: string; thinking?: string; name?: string; id?: string; input?: Record<string, unknown> }[]
              | undefined;

            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text") {
                  lastOutput = block.text || "";
                  pushMessage({ type: "text", content: block.text });
                } else if (block.type === "thinking") {
                  // Note: session JSONL uses `thinking` field, while pipe mode stream-json uses `text`.
                  pushMessage({ type: "thinking", content: block.thinking });
                } else if (block.type === "tool_use") {
                  pushMessage({
                    type: "tool-use",
                    tool: block.name,
                    callId: block.id,
                    input: block.input,
                  });
                }
              }
            }

            // Check for completion
            const stopReason = message.stop_reason as string | undefined;
            if (stopReason === "end_turn") {
              // Send /exit to gracefully close the TUI
              setTimeout(() => {
                writeToStdin(proc, "/exit\n");
              }, 300);
            }
          } else if (eventType === "user") {
            const message = event.message as Record<string, unknown> | undefined;
            if (!message) continue;

            const content = message.content as
              | { type: string; tool_use_id?: string; content?: string; is_error?: boolean }[]
              | undefined;

            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result") {
                  pushMessage({
                    type: "tool-result",
                    callId: block.tool_use_id,
                    output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
                  });
                }
              }
            }
          }
          // Ignore queue-operation, last-prompt, system, and other types
        }
      }

      // --- Spawn PTY ---
      try {
        proc = BunRuntime.Bun.spawn([this.cliPath, ...args], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env, NO_COLOR: "1" },
          terminal: {
            cols: 120,
            rows: 40,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data(_terminal: any, data: any) {
              const text = data instanceof Uint8Array ? decoder.decode(data) : String(data);
              outputBuffer += text;
              lastDataTime = Date.now();

              // Respond to Ink terminal queries
              handleTerminalQueries(text, {
                write: (s: string) => writeToStdin(proc, s),
              });
            },
          },
        });
      } catch (err) {
        resolveSessionId(sessionId);
        messageDone = true;
        if (messageResolve) {
          const r = messageResolve;
          messageResolve = null;
          r();
        }
        resolveResult({
          status: "failed",
          output: "",
          error: `Failed to spawn PTY: ${err}`,
          durationMs: Date.now() - startTime,
          sessionId,
        });
        return;
      }

      resolveSessionId(sessionId);

      // --- TUI readiness detection ---
      const readyCheckInterval = setInterval(() => {
        const now = Date.now();

        // Startup timeout: if TUI never becomes ready
        if (!tuiReady && now - startTime > READY_TIMEOUT_MS) {
          clearInterval(readyCheckInterval);
          lastError = "PTY TUI failed to become ready within timeout";
          resultStatus = "failed";
          proc?.kill();
          return;
        }

        // Check for quiescent state + prompt character
        if (
          !tuiReady &&
          lastDataTime > 0 &&
          now - lastDataTime > QUIESCENT_MS
        ) {
          const stripped = stripAnsi(outputBuffer);
          if (stripped.includes("❯")) {
            tuiReady = true;
            clearInterval(readyCheckInterval);

            // Write the prompt
            if (!promptWritten) {
              promptWritten = true;

              // Start watching JSONL file
              jsonlPath = findJsonlPath(options.cwd, sessionId);

              // Poll for JSONL updates
              jsonlPollTimer = setInterval(processJsonlLines, JSONL_POLL_MS);

              // Write prompt to PTY stdin
              writeToStdin(proc, prompt + "\n");
            }
          }
        }
      }, 100);

      // --- Process exit handling ---
      (async () => {
        try {
          const exitCode = await proc!.exited;

          if (timeoutTimer) clearTimeout(timeoutTimer);
          clearInterval(readyCheckInterval);
          if (jsonlPollTimer) clearInterval(jsonlPollTimer);

          // Final JSONL read to catch any remaining events
          processJsonlLines();

          if (timedOut) {
            resultStatus = "timeout";
          } else if (exitCode !== 0 && resultStatus === "completed") {
            resultStatus = "failed";
          }

          messageDone = true;
          if (messageResolve) {
            const r = messageResolve;
            messageResolve = null;
            r();
          }

          resolveResult({
            status: resultStatus,
            output: lastOutput,
            error: lastError,
            durationMs: Date.now() - startTime,
            sessionId,
          });
        } catch (err) {
          messageDone = true;
          if (messageResolve) {
            const r = messageResolve;
            messageResolve = null;
            r();
          }
          resolveResult({
            status: "failed",
            output: lastOutput,
            error: `PTY process error: ${err}`,
            durationMs: Date.now() - startTime,
            sessionId,
          });
        }
      })();
    });

    // Async message iterator (same pattern as ClaudeBackend)
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

    return {
      pid: proc?.pid,
      messages,
      sessionId: sessionIdPromise,
      result: resultPromise,
    };
  }
}

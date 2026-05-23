import { spawn } from "child_process";
import { createInterface } from "readline";
import type { AgentBackend, AgentSession } from "./index.js";
import type { ExecOptions, AgentMessage, AgentResult } from "../types.js";

export class OpenCodeBackend implements AgentBackend {
  name = "opencode";

  constructor(private cliPath: string) {}

  execute(prompt: string, options: ExecOptions): AgentSession {
    const args = ["run", "--format", "json"];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.resumeSessionId) {
      args.push("--session", options.resumeSessionId);
    }

    // User prompt as positional argument (no flag)
    args.push(prompt);

    const proc = spawn(this.cliPath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env, OPENCODE_PERMISSION: '{"*":"allow"}' },
      shell: process.platform === "win32",
      windowsHide: true,
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
        proc.kill("SIGTERM");
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

    const pushMessage = (msg: AgentMessage) => {
      messageQueue.push(msg);
      if (messageResolve) {
        const r = messageResolve;
        messageResolve = null;
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
          sessionId: lastSessionId,
        });
      });

      proc.on("close", (code: number | null) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);

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

    return { pid: proc.pid, messages, sessionId: sessionIdPromise, result: resultPromise };
  }
}

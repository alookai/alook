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
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env, OPENCODE_PERMISSION: '{"*":"allow"}' },
    });

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

        switch (eventType) {
          case "session": {
            const sessionId = event.session_id as string | undefined;
            if (sessionId) lastSessionId = sessionId;
            pushMessage({
              type: "status",
              status: "session",
              content: sessionId,
            });
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

          case "thinking": {
            const content = event.content as string | undefined;
            pushMessage({ type: "thinking", content });
            break;
          }

          case "tool_call": {
            pushMessage({
              type: "tool-use",
              tool: (event.name as string) || "",
              callId: event.call_id as string,
              input: event.input as Record<string, unknown>,
            });
            break;
          }

          case "tool_result": {
            pushMessage({
              type: "tool-result",
              callId: event.call_id as string,
              output: event.output as string,
            });
            break;
          }

          case "error": {
            const content = (event.message as string) || (event.content as string) || "";
            lastError = content;
            pushMessage({ type: "error", content });
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

    return { messages, result: resultPromise };
  }
}

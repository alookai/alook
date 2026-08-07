/**
 * Hermes Agent backend — the `src/cli` local-runner counterpart to the
 * production daemon's `HermesDriver` (src/daemon/src/drivers/hermes.ts).
 *
 * Hermes is spawned per turn as a bare child process (`hermes chat -q ... -Q
 * --pass-session-id`). Its `-Q` quiet mode prints the final response + a
 * `session_id:` footer; we normalize those lines into AgentMessages /
 * ParsedEvents, exactly the same collapse-the-turn model OpenCode uses.
 *
 * No mid-session stdin steering (per_turn runtime) — `send()` reports
 * unsupported, matching OpenCodeBackend.
 */
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

const SESSION_ID_RE = /^(?:session_?id|session)\s*[:=]\s*(\S+)$/i;

export class HermesBackend implements AgentBackend {
  name = "hermes";
  lifecycle: DriverLifecycle = { kind: "per_turn", inFlightWake: "coalesce_into_pending" };
  busyDeliveryMode: BusyDeliveryMode = "none";
  supportsStdinNotification = false;

  constructor(private cliPath: string) {}

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const sidMatch = SESSION_ID_RE.exec(trimmed);
    if (sidMatch) {
      return [{ kind: "session_init", sessionId: sidMatch[1] }, { kind: "turn_end", sessionId: sidMatch[1] }];
    }
    if (/^(?:error|hermes:?\s*error)\s*[:]/i.test(trimmed)) {
      return [{ kind: "error", message: trimmed }, { kind: "turn_end" }];
    }
    return [{ kind: "text", text: trimmed }];
  }

  encodeStdinMessage(): string | null {
    return null;
  }

  execute(prompt: string, options: ExecOptions): AgentSession {
    const args = ["chat", "-q", prompt, "-Q", "--pass-session-id"];

    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
    if (process.env.ALOOK_HERMES_NO_YOLO !== "1") args.push("--yolo");

    const isWin = process.platform === "win32";
    const spawnCmd = isWin ? quoteWinArg(this.cliPath) : this.cliPath;
    const spawnArgs = isWin ? quoteWinArgs(args) : args;

    const proc = spawn(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...options.env,
        HERMES_QUIET: "1",
        HERMES_INTERACTIVE: "0",
      },
      shell: isWin,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    if (!proc.pid) {
      const error = `Failed to start ${this.cliPath}: binary not found or not executable. Is 'hermes' installed and on PATH?`;
      const failedResult: AgentResult = { status: "failed", output: "", error, durationMs: 0, sessionId: "" };
      const emptyMessages: AsyncIterable<AgentMessage> = {
        [Symbol.asyncIterator]() {
          return { async next() { return { value: undefined as unknown as AgentMessage, done: true }; } };
        },
      };
      return { pid: undefined, messages: emptyMessages, sessionId: Promise.resolve(""), result: Promise.resolve(failedResult) };
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
      if (messageResolve) { const r = messageResolve; messageResolve = null; r(); }
    };
    const pushParsedEvent = (evt: ParsedEvent) => {
      parsedEventQueue.push(evt);
      if (parsedEventResolve) { const r = parsedEventResolve; parsedEventResolve = null; r(); }
    };

    const resultPromise = new Promise<AgentResult>((resolve) => {
      const stderrChunks: string[] = [];

      proc.stderr?.on("data", (chunk: Buffer) => { stderrChunks.push(chunk.toString()); });

      const rl = createInterface({ input: proc.stdout! });

      rl.on("line", (line: string) => {
        if (!line.trim()) return;
        const parsed = this.parseLine(line);
        for (const pe of parsed) pushParsedEvent(pe);

        const sidMatch = SESSION_ID_RE.exec(line.trim());
        if (sidMatch) {
          lastSessionId = sidMatch[1];
          resolveSessionId(lastSessionId);
          return;
        }
        if (/^(?:error|hermes:?\s*error)\s*[:]/i.test(line.trim())) {
          lastError = line.trim();
          resultStatus = "failed";
          pushMessage({ type: "error", content: line.trim() });
          turnDone();
          return;
        }
        // Plain response text.
        lastOutput = line.trim();
        pushMessage({ type: "text", content: line.trim() });
      });

      proc.on("error", (err: Error) => {
        resultStatus = "failed";
        lastError = `spawn error: ${err.message}`;
        resolveSessionId(lastSessionId);
        messageDone = true;
        parsedEventDone = true;
        if (messageResolve) { const r = messageResolve; messageResolve = null; r(); }
        if (parsedEventResolve) { const r = parsedEventResolve; parsedEventResolve = null; r(); }
        resolve({ status: "failed", output: "", error: lastError, durationMs: Date.now() - startTime, sessionId: lastSessionId });
      });

      proc.on("close", (code: number | null) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (timedOut) resultStatus = "timeout";
        else if (code !== 0 && resultStatus === "completed" && !turnDoneTriggered && !lastOutput) {
          resultStatus = "failed";
        }
        const stderr = stderrChunks.join("");
        if (stderr && !lastError) lastError = stderr;
        resolveSessionId(lastSessionId);
        messageDone = true;
        parsedEventDone = true;
        if (messageResolve) { const r = messageResolve; messageResolve = null; r(); }
        if (parsedEventResolve) { const r = parsedEventResolve; parsedEventResolve = null; r(); }
        resolve({ status: resultStatus, output: lastOutput, error: lastError, durationMs: Date.now() - startTime, sessionId: lastSessionId });
      });
    });

    const messages: AsyncIterable<AgentMessage> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentMessage>> {
            while (messageQueue.length === 0 && !messageDone) {
              await new Promise<void>((resolve) => { messageResolve = resolve; });
            }
            if (messageQueue.length > 0) return { value: messageQueue.shift()!, done: false };
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
              await new Promise<void>((resolve) => { parsedEventResolve = resolve; });
            }
            if (parsedEventQueue.length > 0) return { value: parsedEventQueue.shift()!, done: false };
            return { value: undefined as unknown as ParsedEvent, done: true };
          },
        };
      },
    };

    const send = (): { ok: boolean; reason?: string } => ({ ok: false, reason: "unsupported" });

    const descriptor = {
      lifecycle: this.lifecycle,
      busyDeliveryMode: this.busyDeliveryMode,
      supportsStdinNotification: this.supportsStdinNotification,
    };

    return { pid: proc.pid, messages, parsedEvents, sessionId: sessionIdPromise, result: resultPromise, send, descriptor };
  }
}

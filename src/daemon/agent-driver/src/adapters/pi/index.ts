/** In-process Pi SDK adapter; the controller sends only after listeners attach. */
import { createRequire } from "module";
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import type {
  BackendAdapter, AdapterLaunchContext, AdapterEvent, VendorSessionHandle,
} from "../../internal/adapter.js";
import { SdkLane } from "../../controller/sdk-host.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { resolveCommandOnPath, type ProbeDeps } from "../../internal/probe.js";
import { createPiSessionDependencies, type PiSessionDependencies } from "./sessionDeps.js";

const PI_SDK_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

interface PiSdkAgentSession {
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly isStreaming: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
}

function isPiSdkPackageJson(pkgJsonPath: string): boolean {
  if (!existsSync(pkgJsonPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { name?: string };
    return pkg.name === PI_SDK_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Finds a globally installed Pi SDK from the PATH binary. Handles POSIX
 * symlinks and Windows shims with sibling node_modules layouts.
 */
export function resolvePiSdkPackageDir(deps: ProbeDeps = {}): string | undefined {
  const binPath = resolveCommandOnPath("pi", deps);
  if (!binPath) return undefined;

  try {
    let dir = path.dirname(realpathSync(binPath));
    const MAX_DEPTH = 8;
    for (let i = 0; i < MAX_DEPTH; i++) {
      if (isPiSdkPackageJson(path.join(dir, "package.json"))) return dir;

      const siblingDir = path.join(dir, "node_modules", PI_SDK_PACKAGE_NAME);
      if (isPiSdkPackageJson(path.join(siblingDir, "package.json"))) return siblingDir;

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return undefined;
}

/** Finds Pi's persisted `<date>_<sessionId>.jsonl` rollout. */
export function findPiSessionFile(sessionDir: string, sessionId: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  const match = entries.find((entry) => entry.endsWith(suffix));
  return match ? path.join(sessionDir, match) : null;
}

/**
 * Resolve the Pi SDK's session directory for `cwd`.
 *
 * Prefers the SDK's own `getDefaultSessionDir`. That function is NOT on the
 * vendor barrel (it enumerates re-exports by name and omits this one), so
 * calling it unconditionally throws `sdk.getDefaultSessionDir is not a
 * function` and takes down every Pi resume — `withSessionDirHelper` in
 * `sessionDeps.ts` grafts it on from the deep `core/session-manager.js` module,
 * which is why it's usually present here despite the barrel gap.
 *
 * The fallback reproduces the SDK's rule (`core/session-manager.js`):
 * `<agentDir>/sessions/--<cwd with the leading separator stripped and
 * remaining separators/colons turned into dashes>--`, rooted at the exported
 * `getAgentDir()` (or `~/.pi/agent`). `getAgentDir` is the very function
 * `session-manager.js` itself imports as `getDefaultAgentDir`, so the two
 * paths agree today. This copy is the layer that can rot if the vendor
 * changes its encoding — see the drift note in the plan.
 *
 * Unlike the SDK helper this does not create the directory. That's fine:
 * `SessionManager` mkdirs on its first write, and `findPiSessionFile` treats
 * a missing dir as "no match" rather than an error.
 */
export function resolvePiSessionDir(
  sdk: { getDefaultSessionDir?: (cwd: string) => string; getAgentDir?: () => string },
  cwd: string,
): string {
  if (typeof sdk.getDefaultSessionDir === "function") return sdk.getDefaultSessionDir(cwd);
  const agentDir = typeof sdk.getAgentDir === "function"
    ? sdk.getAgentDir()
    : path.join(homedir(), ".pi", "agent");
  const encoded = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", encoded);
}

/** Read just the version out of the package.json `resolvePiSdkPackageDir` finds. */
export function resolvePiSdkVersionFromPath(deps: ProbeDeps = {}): string | undefined {
  const dir = resolvePiSdkPackageDir(deps);
  if (!dir) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Read the installed Pi SDK's package version. Optional — the SDK isn't a
 * hard dep of the daemon, so we return undefined when it isn't installed on
 * the host, and the runtime chip renders without a version.
 *
 * Two detection paths, tried in order:
 *   1. `require()` resolution relative to this file — succeeds when Pi is a
 *      real dependency somewhere up the daemon's own `node_modules` tree
 *      (e.g. a future packaged build that bundles it).
 *   2. `resolvePiSdkVersionFromPath()` — succeeds when `pi` is installed
 *      globally and only reachable via `PATH`, which is how most users
 *      actually install it.
 */
function readPiSdkVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("@earendil-works/pi-coding-agent/package.json") as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    // Not resolvable as a normal Node dependency — fall through to the
    // PATH-based fallback below.
  }
  return resolvePiSdkVersionFromPath();
}

/** Vendor notifications that intentionally carry no public semantic event. */
export const PI_IGNORED_EVENT_TYPES = [
  "agent_start",
  "turn_start",
  "turn_end",
  "message_end",
  "tool_execution_update",
  "queue_update",
  "session_info_changed",
  "thinking_level_changed",
  "agent_end",
] as const;

/** Map a Pi SDK event to zero or more normalized events. */
export function mapPiSdkEvent(event: any, sessionId: string, state: { sawTextDelta: boolean }): AdapterEvent[] {
  if (event?.type === "message_update") {
    const d = event.delta ?? {};
    switch (d.type) {
      case "thinking_delta":
        return [{ kind: "assistant_reasoning_delta", text: d.delta ?? "" }];
      case "text_delta":
        state.sawTextDelta = true;
        return [{ kind: "assistant_message_delta", text: d.delta ?? "" }];
      case "text_end": {
        state.sawTextDelta = false;
        return [{ kind: "assistant_message_completed", text: d.content ?? "" }];
      }
      case "error":
        return [{ kind: "error", message: d.message ?? "Pi error" }];
      default:
        return [];
    }
  }
  switch (event?.type) {
    case "auto_retry_start":
      return [{ kind: "runtime_recovery", stage: "retrying", source: "pi_auto_retry" }];
    case "auto_retry_end":
      return [{ kind: "runtime_recovery", stage: "recovered", source: "pi_auto_retry" }];
    case "tool_execution_start":
      return [{ kind: "tool_call", name: event.toolName ?? "unknown_tool", input: event.args ?? {} }];
    case "tool_execution_end":
      return [{ kind: "tool_output", name: event.toolName ?? "unknown_tool" }];
    case "compaction_start":
      return [{ kind: "compaction_started" }];
    case "compaction_end":
      return [{ kind: "compaction_finished" }];
    default:
      // PI_IGNORED_EVENT_TYPES documents the complete known no-op family.
      return [];
  }
}

export class PiDriver implements BackendAdapter {
  readonly id = "pi";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "in_process_sdk", protocol: "pi_sdk" },
    wakeStart: "immediate",
    terminalOwnership: "prompt_invocation",
  } as const;

  private sessionId: string | null = null;
  private terminalSequence = 0;

  constructor(
    private readonly dependenciesFor: (ctx: AdapterLaunchContext) => PiSessionDependencies = createPiSessionDependencies,
  ) {}

  probe() {
    const version = readPiSdkVersion();
    if (!version) {
      // The Pi SDK is a native runtime — no CLI to spawn. If the npm module
      // isn't require-able, treat the runtime as unhealthy so /community
      // reflects reality and the bot picker filters it out.
      return { status: "unhealthy" as const, lastError: "sdk_not_installed" };
    }
    return { status: "healthy" as const, version };
  }

  /**
   * In-process session factory. The adapter owns vendor loading and session
   * construction; callers see only the public logical session.
   *
   * Builds and wires the session but deliberately does NOT fire the initial
   * prompt — the SDK lane emits on a plain `EventEmitter`,
   * which drops events fired before any listener is attached (unlike a child
   * process's buffered stdout pipe). The logical session controller
   * attaches its own `"runtime_event"` listener to the session this returns
   * BEFORE sending the first turn via `.send()`, so nothing is lost.
   */
  async openLane(ctx: AdapterLaunchContext): Promise<SdkLane> {
    const deps = this.dependenciesFor(ctx);
    const spawnEnv = await deps.buildSpawnEnv();
    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const { session, sessionId } = (await deps.createAgentSession({
      cwd: ctx.workingDirectory,
      sessionId: ctx.config.sessionId,
      model: f.model,
      thinkingLevel: f.reasoningEffort,
      spawnEnv, // injected into the custom bash tool
    })) as { session: PiSdkAgentSession; sessionId: string };
    this.sessionId = sessionId;

    const state = { sawTextDelta: false };
    const handle: VendorSessionHandle = {
      // A root turn is owned by this exact prompt promise. Never downgrade it
      // to followUp/steer, whose completion belongs to a different invocation.
      // SdkLane waits for idle and turns a persistent-busy race into a
      // controlled failed terminal instead of guessing terminal ownership.
      prompt: (t: string) => session.prompt(t),
      steer: (t: string) => session.steer(t),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
      get isStreaming() {
        return session.isStreaming;
      },
    };
    const runtimeSession = new SdkLane(handle, this.sessionId!, { terminalOnPromptSettled: true });
    session.subscribe((event: unknown) => {
      runtimeSession.emitEvents(mapPiSdkEvent(event, this.sessionId!, state));
    });

    return runtimeSession;
  }

  normalizeLine(): AdapterEvent[] {
    return [];
  }

  beginTurn(): string {
    return `pi:${++this.terminalSequence}`;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  encodeMessage(): string | null {
    return null;
  }

}

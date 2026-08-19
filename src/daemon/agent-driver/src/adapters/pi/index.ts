/**
 * Pi driver — in-process, multi-provider SDK runtime (@earendil-works/pi-coding-agent).
 *
 * Pi runs in-process (no child process, no stdin). It is
 * multi-provider: model ids look like `provider/id` and resolve through an
 * auth/settings registry (Google / OpenAI / OpenRouter). Sessions persist as
 * JSONL; a custom bash tool is injected so shell calls inherit the CLI-transport
 * env. Steering is `direct` (guarded by `session.isStreaming`).
 *
 * The core materializes the standing prompt as `AGENTS.md` before opening the
 * in-process SDK lane. Pi's bash tool still uses the shared CLI environment.
 *
 * `openSdkSession` only builds and wires the session — it does not send the
 * first turn. The logical session controller attaches its normalized-event
 * listener to
 * the returned session first, then sends the initial prompt, so nothing
 * fires into an unlistened `EventEmitter` and gets dropped.
 */
import { createRequire } from "module";
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import type { BackendAdapter, AdapterLaunchContext, AdapterEvent, VendorSessionHandle } from "../../internal/adapter.js";
import { SdkLane } from "../../controller/sdk-host.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { resolveCommandOnPath, type ProbeDeps } from "../../internal/probe.js";
import { createPiSessionDependencies, type PiSessionDependencies } from "./sessionDeps.js";

const PI_SDK_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Minimal shape of the vendor SDK's `AgentSession` this driver actually calls. */
interface PiSdkAgentSession {
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly isStreaming: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
}

/** True if `pkgJsonPath` exists and is the pi SDK's own `package.json`. */
function isPiSdkPackageJson(pkgJsonPath: string): boolean {
  if (!existsSync(pkgJsonPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { name?: string };
    return pkg.name === PI_SDK_PACKAGE_NAME;
  } catch {
    // Malformed package.json — treat as "not this package"; the caller
    // keeps walking, it may just be an unrelated file that happens to sit
    // alongside the binary.
    return false;
  }
}

/**
 * Fallback SDK detection for a globally-installed `pi` (e.g. `npm install -g
 * @earendil-works/pi-coding-agent`, a Homebrew formula, or a pnpm/yarn/nvm
 * global install). `require()` from the daemon's own file location can never
 * see a global install — it lives in a completely separate `node_modules`
 * tree — even though `pi --version` works fine in a shell. So instead we
 * resolve the `pi` binary on `PATH` (same as every other driver's `probe()`)
 * and walk upward from it looking for the package's own `package.json`,
 * checking two shapes at each level:
 *   1. `dir` itself IS inside the package — true on POSIX, where the PATH
 *      resolution follows a symlink through `realpathSync` into the
 *      package's real install directory (npm/Homebrew/pnpm/yarn/nvm all do
 *      this).
 *   2. `dir/node_modules/@earendil-works/pi-coding-agent` — true on Windows,
 *      where npm writes the `.cmd` shim as a real file directly in the
 *      global prefix root (e.g. `%AppData%\npm`) rather than a symlink INTO
 *      the package, so `realpathSync` never gets us inside it; the actual
 *      package instead sits in a SIBLING `node_modules` folder at that same
 *      level, never an ancestor.
 * This is package-manager-agnostic: it doesn't assume npm specifically (no
 * `npm root -g` shell-out), so it keeps working no matter how the global
 * install actually got there.
 *
 * Also used by `sessionDeps.ts::loadPiSdkModule` to find the real install
 * directory to `import()` when the SDK isn't a bundled dependency.
 */
export function resolvePiSdkPackageDir(deps: ProbeDeps = {}): string | undefined {
  const binPath = resolveCommandOnPath("pi", deps);
  if (!binPath) return undefined;

  try {
    let dir = path.dirname(realpathSync(binPath));
    // 8 levels is enough to cover every layout we've seen: npm/pnpm globals
    // resolve within 2-4 hops, nvm adds ~1, Homebrew Cellar adds ~2, and
    // Windows `.cmd` shims sit alongside a sibling `node_modules` at the same
    // root (0 hops upward, checked as the second shape below). Higher would
    // wander into unrelated ancestor trees; lower would miss nvm-under-brew.
    const MAX_DEPTH = 8;
    for (let i = 0; i < MAX_DEPTH; i++) {
      if (isPiSdkPackageJson(path.join(dir, "package.json"))) return dir;

      const siblingDir = path.join(dir, "node_modules", PI_SDK_PACKAGE_NAME);
      if (isPiSdkPackageJson(path.join(siblingDir, "package.json"))) return siblingDir;

      const parent = path.dirname(dir);
      if (parent === dir) break; // hit filesystem root
      dir = parent;
    }
  } catch {
    // Broken symlink, permission error, etc. — treat as not found.
  }
  return undefined;
}

/**
 * Locate the Pi SDK session-rollout file for `sessionId` in `sessionDir`.
 *
 * Pi persists each session as `<isoDate>_<sessionId>.jsonl` inside its session
 * directory (`--<encoded-cwd>--`). To resume a specific session we need the
 * actual file path — not just the id — because `SessionManager.open` takes a
 * path. Returns null if the directory is unreadable or no matching file exists
 * (the caller falls back to `create` in that case).
 *
 * Pure enough to unit-test without touching the SDK: read a directory, filter
 * by suffix, return the first match.
 */
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
  "auto_retry_start",
  "auto_retry_end",
] as const;

/** Map a Pi SDK event to zero or more normalized events. */
export function mapPiSdkEvent(event: any, sessionId: string, state: { sawTextDelta: boolean }): AdapterEvent[] {
  if (event?.type === "message_update") {
    const d = event.delta ?? {};
    switch (d.type) {
      case "thinking_delta":
        return [{ kind: "thinking", text: d.delta ?? "" }];
      case "text_delta":
        state.sawTextDelta = true;
        return [{ kind: "text", text: d.delta ?? "" }];
      case "text_end":
        return state.sawTextDelta ? [] : [{ kind: "text", text: d.content ?? "" }];
      case "error":
        return [{ kind: "error", message: d.message ?? "Pi error" }];
      default:
        return [];
    }
  }
  switch (event?.type) {
    case "tool_execution_start":
      return [{ kind: "tool_call", name: event.toolName ?? "unknown_tool", input: event.args ?? {} }];
    case "tool_execution_end":
      return [{ kind: "tool_output", name: event.toolName ?? "unknown_tool" }];
    case "compaction_start":
      return [{ kind: "compaction_started" }];
    case "compaction_end":
      return [{ kind: "compaction_finished" }];
    case "agent_end":
      return [{ kind: "turn_end", sessionId }];
    default:
      // PI_IGNORED_EVENT_TYPES documents the complete known no-op family.
      return [];
  }
}

export class PiDriver implements BackendAdapter {
  readonly id = "pi";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = { kind: "in_process_sdk", input: "direct" } as const;

  private sessionId: string | null = null;

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
  async openSdkSession(ctx: AdapterLaunchContext): Promise<SdkLane> {
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
      // `session.prompt()` throws "Agent is already processing" if a prior
      // turn is still streaming (the controller's send is
      // the primary defense — this is a belt-and-suspenders guard against
      // any remaining window between our own turn_end detection and the SDK
      // flipping `isStreaming`): queue as a follow-up instead of throwing.
      prompt: (t: string) => session.prompt(t, session.isStreaming ? { streamingBehavior: "followUp" } : undefined),
      steer: (t: string) => session.steer(t),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
      get isStreaming() {
        return session.isStreaming;
      },
    };
    const runtimeSession = new SdkLane(handle, this.sessionId!);
    session.subscribe((event: unknown) =>
      runtimeSession.emitEvents(mapPiSdkEvent(event, this.sessionId!, state)),
    );

    return runtimeSession;
  }

  normalizeLine(): AdapterEvent[] {
    return [];
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  encodeMessage(): string | null {
    return null;
  }

}

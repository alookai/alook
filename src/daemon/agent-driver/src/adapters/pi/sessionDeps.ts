/**
 * Real session dependencies for `PiDriver` — the only piece that
 * actually talks to `@earendil-works/pi-coding-agent`. Kept out of `pi.ts` so
 * that file stays free of a hard SDK import (mirrors the "deps carry the
 * constructors" design already documented there); this module is where the
 * daemon actually loads and drives the vendor package.
 */
import { readFileSync } from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { AdapterLaunchContext } from "../../internal/adapter.js";
import { findPiSessionFile, resolvePiSdkPackageDir, resolvePiSessionDir } from "./index.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";

const PI_SDK_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** The slice of the vendor SDK's module exports this file actually calls. */
export interface PiSdkModule {
  AuthStorage: { create(authPath?: string): PiAuthStorage };
  ModelRegistry: { create(authStorage: PiAuthStorage, modelsPath?: string): PiModelRegistry };
  SessionManager: {
    create(cwd: string, sessionDir?: string, options?: { id?: string }): unknown;
    open(path: string, sessionDir?: string, cwdOverride?: string): unknown;
    continueRecent(cwd: string, sessionDir?: string): unknown;
  };
  /**
   * The SDK's own `<sessionDir>` resolver. Declared in
   * `core/session-manager.d.ts` and defined in the matching `.js`, but NOT
   * re-exported by the package barrel (which lists its exports by name and
   * omits this one) — so it is absent on a plain top-level import. Optional
   * for that reason. `withSessionDirHelper` grafts it on from the deep module
   * when it can; `resolvePiSessionDir` reproduces the rule when it can't.
   */
  getDefaultSessionDir?(cwd: string, agentDir?: string): string;
  /** Root of the SDK's own config dir (`~/.pi/agent`) — this one IS exported. */
  getAgentDir?(): string;
  createBashToolDefinition(cwd: string, options?: PiBashToolOptions): unknown;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: unknown; sessionId?: string }>;
}
export interface PiAuthStorage {
  setRuntimeApiKey(provider: string, apiKey: string): void;
}
export interface PiModelRegistry {
  find(provider: string, modelId: string): unknown | undefined;
  getAvailable(): unknown[] | Promise<unknown[]>;
}
interface PiBashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}
interface PiBashToolOptions {
  spawnHook?: (context: PiBashSpawnContext) => PiBashSpawnContext;
}

/** Injectable loader for tests — never actually imports the real package. */
export type PiSdkLoader = () => Promise<PiSdkModule>;

let cachedSdkPromise: Promise<PiSdkModule> | null = null;

async function importPiSdkFromGlobalInstall(): Promise<PiSdkModule> {
  const dir = resolvePiSdkPackageDir();
  if (!dir) {
    throw new Error(
      `${PI_SDK_PACKAGE_NAME} not found — install it (e.g. \`npm install -g ${PI_SDK_PACKAGE_NAME}\`) before launching a pi agent`,
    );
  }
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as {
    main?: string;
    exports?: { "."?: { import?: string } };
  };
  const entry = pkg.exports?.["."]?.import ?? pkg.main ?? "./dist/index.js";
  const entryPath = path.join(dir, entry);
  const barrel = (await import(pathToFileURL(entryPath).href)) as PiSdkModule;
  return withSessionDirHelper(barrel, entryPath);
}

/**
 * Graft the vendor's own `getDefaultSessionDir` onto the barrel module.
 *
 * The function is declared in `core/session-manager.d.ts` and defined in the
 * matching `.js`, but the package's top-level barrel enumerates its re-exports
 * by name and omits it — so `sdk.getDefaultSessionDir` is undefined on the
 * module we load. Its body encodes a path-substitution rule (see
 * `resolvePiSessionDir`) that we'd rather call than reimplement: a duplicated
 * copy rots silently into a wrong-but-plausible directory, turning a resume
 * into a fresh session with no error.
 *
 * The package's `exports` map only exposes `.` and `./rpc-entry`, so a bare
 * deep specifier is blocked — but we already load by file URL (global installs
 * aren't resolvable by name from the daemon), and a file URL bypasses the map.
 *
 * Best-effort by design: on any failure (vendor relayout, the file genuinely
 * moving) we return the barrel untouched and `resolvePiSessionDir` falls back
 * to reproducing the rule. Never throws — a missing helper must not be the
 * reason a Pi launch fails.
 */
async function withSessionDirHelper(barrel: PiSdkModule, entryPath: string): Promise<PiSdkModule> {
  if (typeof barrel.getDefaultSessionDir === "function") return barrel;
  try {
    const deepPath = path.join(path.dirname(entryPath), "core", "session-manager.js");
    const deep = (await import(pathToFileURL(deepPath).href)) as {
      getDefaultSessionDir?: (cwd: string, agentDir?: string) => string;
    };
    if (typeof deep.getDefaultSessionDir !== "function") return barrel;
    // The barrel is a live module namespace object (frozen, read-only) — copy
    // onto a fresh object rather than mutating it.
    return { ...barrel, getDefaultSessionDir: deep.getDefaultSessionDir };
  } catch {
    return barrel;
  }
}

/**
 * Loads (and memoizes for the life of the daemon process) the pi SDK module.
 * Two-path detection mirroring `readPiSdkVersion`: try the bare specifier
 * first (works if it's ever a real bundled dependency), then fall back to
 * resolving the real global-install directory and `import()`-ing its entry
 * file directly.
 *
 * Only a SUCCESSFUL load is memoized. A failure (SDK not installed yet, a
 * transient fs error, `pi` not on PATH at daemon startup) clears the cache
 * before rethrowing, so the next spawn attempt re-resolves from scratch
 * instead of replaying the same rejected promise forever — otherwise a user
 * who installs/fixes the SDK after the daemon's first failed attempt would
 * need to restart the daemon before any pi agent could ever launch again.
 */
export function loadPiSdkModule(): Promise<PiSdkModule> {
  if (!cachedSdkPromise) {
    cachedSdkPromise = (async () => {
      try {
        return (await import(PI_SDK_PACKAGE_NAME)) as PiSdkModule;
      } catch {
        return importPiSdkFromGlobalInstall();
      }
    })().catch((err: unknown) => {
      cachedSdkPromise = null;
      throw err;
    });
  }
  return cachedSdkPromise;
}

/** Parse a `"provider/id"` model string; undefined pieces mean "use the SDK's own default". */
function parseModelString(model: string | undefined): { provider: string; id: string } | undefined {
  if (!model) return undefined;
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) return undefined;
  return { provider: model.slice(0, idx), id: model.slice(idx + 1) };
}

/**
 * Build the real Pi session dependencies for a launch. Closes over `ctx` so
 * `buildSpawnEnv` needs no arguments (matches `PiDriver.openLane`'s
 * existing contract) — a fresh instance is built per launch, so nothing here
 * is process-global mutable state (safe for concurrent agents with different
 * credentials).
 */
export interface PiSessionDependencies {
  buildSpawnEnv(): Promise<NodeJS.ProcessEnv>;
  createAgentSession(opts: Record<string, unknown>): Promise<{ session: unknown; sessionId: string }>;
}

export function createPiSessionDependencies(
  ctx: AdapterLaunchContext,
  loadSdk: PiSdkLoader = loadPiSdkModule,
): PiSessionDependencies {
  return {
    async buildSpawnEnv(): Promise<NodeJS.ProcessEnv> {
      // Pi has no child process of its own, but its bash tool does — reuse the
      // exact same credential-voucher + PATH-link machinery every CLI driver
      // gets via `prepareCliTransport`, so the agent's `alook` bash calls
      // authenticate the same zero-trust way.
      const { spawnEnv } = await prepareCliTransport(ctx);
      return spawnEnv;
    },

    async createAgentSession(opts: Record<string, unknown>): Promise<{ session: unknown; sessionId: string }> {
      const sdk = await loadSdk();
      const authStorage = sdk.AuthStorage.create();
      const runtimeConfig = ctx.config.runtimeConfig;
      const provider = runtimeConfig && "provider" in runtimeConfig
        ? runtimeConfig.provider
        : undefined;
      if (provider?.kind === "builtin") {
        authStorage.setRuntimeApiKey(provider.providerId, provider.apiKey);
      }
      const modelRegistry = sdk.ModelRegistry.create(authStorage);

      const parsed = parseModelString(opts.model as string | undefined);
      const model = parsed ? modelRegistry.find(parsed.provider, parsed.id) : undefined;

      const cwd = opts.cwd as string;
      // Three-branch session acquisition — see the plan's Designs section:
      //   (i)  sessionId + matching rollout file → SessionManager.open(...)
      //   (ii) sessionId + no matching file       → create(cwd, sessionDir, { id })
      //   (iii) no sessionId                      → create(cwd) (fresh)
      // We intentionally do NOT call continueRecent() for the no-id path —
      // that would silently inherit whichever session ran last in this cwd,
      // producing a real regression (wrong session on any workdir that has
      // hosted more than one session).
      const requestedSessionId = opts.sessionId as string | undefined;
      let sessionManager: unknown;
      if (requestedSessionId) {
        const sessionDir = resolvePiSessionDir(sdk, cwd);
        const existingFile = findPiSessionFile(sessionDir, requestedSessionId);
        sessionManager = existingFile
          ? sdk.SessionManager.open(existingFile, sessionDir, cwd)
          : sdk.SessionManager.create(cwd, sessionDir, { id: requestedSessionId });
      } else {
        sessionManager = sdk.SessionManager.create(cwd);
      }

      const spawnEnv = opts.spawnEnv as NodeJS.ProcessEnv;
      const bashTool = sdk.createBashToolDefinition(cwd, {
        spawnHook: (spawnCtx) => ({ ...spawnCtx, env: { ...spawnCtx.env, ...spawnEnv } }),
      });

      const { session, sessionId } = await sdk.createAgentSession({
        cwd,
        model,
        thinkingLevel: opts.thinkingLevel,
        authStorage,
        modelRegistry,
        sessionManager,
        customTools: [bashTool],
      });
      // The SDK returns the id on the session itself (`session.sessionId`),
      // not on the createAgentSession result — fall back to that.
      const resolvedSessionId = sessionId ?? (session as { sessionId?: string }).sessionId;
      if (!resolvedSessionId) throw new Error("pi SDK createAgentSession did not produce a sessionId");
      return { session, sessionId: resolvedSessionId };
    },
  };
}

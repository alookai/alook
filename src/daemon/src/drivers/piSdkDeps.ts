/**
 * Real `SdkDriverDeps` implementation for `PiDriver` — the only piece that
 * actually talks to `@earendil-works/pi-coding-agent`. Kept out of `pi.ts` so
 * that file stays free of a hard SDK import (mirrors the "deps carry the
 * constructors" design already documented there); this module is where the
 * daemon actually loads and drives the vendor package.
 */
import { readFileSync } from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { LaunchContext, SdkDriverDeps } from "../types.js";
import { resolvePiSdkPackageDir } from "./pi.js";
import { prepareCliTransport, DEFAULT_CLI_CONFIG } from "./cliTransport.js";

const PI_SDK_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** The slice of the vendor SDK's module exports this file actually calls. */
export interface PiSdkModule {
  AuthStorage: { create(authPath?: string): PiAuthStorage };
  ModelRegistry: { create(authStorage: PiAuthStorage, modelsPath?: string): PiModelRegistry };
  SessionManager: {
    create(cwd: string): unknown;
    continueRecent(cwd: string): unknown;
  };
  createBashToolDefinition(cwd: string, options?: PiBashToolOptions): unknown;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: unknown; sessionId?: string }>;
}
export interface PiAuthStorage {
  setRuntimeApiKey(provider: string, apiKey: string): void;
}
export interface PiModelRegistry {
  find(provider: string, modelId: string): unknown | undefined;
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
  return import(pathToFileURL(entryPath).href) as Promise<PiSdkModule>;
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
 * Build the real `SdkDriverDeps` for a Pi launch. Closes over `ctx` so
 * `buildSpawnEnv` needs no arguments (matches `PiDriver.createSession`'s
 * existing contract) — a fresh instance is built per launch, so nothing here
 * is process-global mutable state (safe for concurrent agents with different
 * credentials).
 */
export function createPiSdkDriverDeps(ctx: LaunchContext, loadSdk: PiSdkLoader = loadPiSdkModule): SdkDriverDeps {
  return {
    async buildSpawnEnv(): Promise<NodeJS.ProcessEnv> {
      // Pi has no child process of its own, but its bash tool does — reuse the
      // exact same credential-voucher + PATH-link machinery every CLI driver
      // gets via `prepareCliTransport`, so the agent's `alook` bash calls
      // authenticate the same zero-trust way.
      const cliConfig = ctx.agentCliPath ? { ...DEFAULT_CLI_CONFIG, hostCliPath: ctx.agentCliPath } : DEFAULT_CLI_CONFIG;
      const { spawnEnv } = await prepareCliTransport(ctx, {}, cliConfig);
      return spawnEnv;
    },

    async createAgentSession(opts: Record<string, unknown>): Promise<{ session: unknown; sessionId: string }> {
      const sdk = await loadSdk();
      const authStorage = sdk.AuthStorage.create();
      const provider = ctx.config.runtimeConfig?.provider;
      if (provider?.kind === "pi-builtin") {
        authStorage.setRuntimeApiKey(provider.providerId, provider.apiKey);
      }
      const modelRegistry = sdk.ModelRegistry.create(authStorage);

      const parsed = parseModelString(opts.model as string | undefined);
      const model = parsed ? modelRegistry.find(parsed.provider, parsed.id) : undefined;

      const cwd = opts.cwd as string;
      const sessionManager = opts.sessionId ? sdk.SessionManager.continueRecent(cwd) : sdk.SessionManager.create(cwd);

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

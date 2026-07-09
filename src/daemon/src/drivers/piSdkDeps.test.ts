import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPiSdkDriverDeps, loadPiSdkModule, type PiSdkModule, type PiSdkLoader } from "./piSdkDeps.js";
import { CredentialBroker } from "../credentials/credentialProxy.js";
import type { LaunchContext } from "../types.js";
import { makeRuntimeConfig } from "../runtimeConfig.js";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-deps-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function baseCtx(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    agentId: "agent_1",
    launchId: "launch_1",
    workingDirectory: mkTmp(),
    standingPrompt: "",
    prompt: "",
    credentialProxy: {
      broker: new CredentialBroker({ upstreamBaseUrl: "https://upstream.test", voucherDir: mkTmp() }),
      proxyUrl: "http://127.0.0.1:9/proxy",
      runnerKey: "sk_agent_test",
    },
    config: {},
    ...overrides,
  };
}

/** A fake SDK module — never touches the real @earendil-works/pi-coding-agent. */
function fakeSdk(): {
  loader: PiSdkLoader;
  setRuntimeApiKey: ReturnType<typeof vi.fn>;
  findModel: ReturnType<typeof vi.fn>;
  sessionManagerCreate: ReturnType<typeof vi.fn>;
  sessionManagerContinueRecent: ReturnType<typeof vi.fn>;
  createBashToolDefinition: ReturnType<typeof vi.fn>;
  createAgentSession: ReturnType<typeof vi.fn>;
} {
  const setRuntimeApiKey = vi.fn();
  const findModel = vi.fn().mockReturnValue({ provider: "google", id: "gemini-2.5-pro" });
  const sessionManagerCreate = vi.fn().mockReturnValue({ tag: "fresh" });
  const sessionManagerContinueRecent = vi.fn().mockReturnValue({ tag: "continued" });
  const createBashToolDefinition = vi.fn().mockReturnValue({ name: "bash" });
  const createAgentSession = vi.fn().mockResolvedValue({ session: { sessionId: "sess-from-sdk" } });

  const sdk: PiSdkModule = {
    AuthStorage: { create: () => ({ setRuntimeApiKey }) },
    ModelRegistry: { create: () => ({ find: findModel }) },
    SessionManager: { create: sessionManagerCreate, continueRecent: sessionManagerContinueRecent },
    createBashToolDefinition,
    createAgentSession,
  };
  return {
    loader: async () => sdk,
    setRuntimeApiKey,
    findModel,
    sessionManagerCreate,
    sessionManagerContinueRecent,
    createBashToolDefinition,
    createAgentSession,
  };
}

describe("createPiSdkDriverDeps — buildSpawnEnv", () => {
  it("delegates to prepareCliTransport: credential voucher present, PATH includes the link dir", async () => {
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fakeSdk().loader);

    const env = await deps.buildSpawnEnv();

    expect(env.ALOOK_PROXY_URL).toBe("http://127.0.0.1:9/proxy");
    expect(env.ALOOK_PROXY_TOKEN_FILE).toBeTruthy();
    expect((env.PATH ?? "").split(path.delimiter)[0]).toContain(path.join(".alook", "bin"));
  });
});

describe("createPiSdkDriverDeps — createAgentSession", () => {
  it("sets the runtime API key when the runtime config carries a pi-builtin provider", async () => {
    const fake = fakeSdk();
    const ctx = baseCtx({
      config: { runtimeConfig: makeRuntimeConfig({ runtime: "pi", provider: { kind: "pi-builtin", providerId: "google", apiKey: "key-123" } }) },
    });
    const deps = createPiSdkDriverDeps(ctx, fake.loader);

    await deps.createAgentSession({ cwd: ctx.workingDirectory, spawnEnv: {} });

    expect(fake.setRuntimeApiKey).toHaveBeenCalledWith("google", "key-123");
  });

  it("does not set a runtime API key when there is no pi-builtin provider", async () => {
    const fake = fakeSdk();
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fake.loader);

    await deps.createAgentSession({ cwd: ctx.workingDirectory, spawnEnv: {} });

    expect(fake.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("resolves a 'provider/id' model string via modelRegistry.find", async () => {
    const fake = fakeSdk();
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fake.loader);

    await deps.createAgentSession({ cwd: ctx.workingDirectory, model: "google/gemini-2.5-pro", spawnEnv: {} });

    expect(fake.findModel).toHaveBeenCalledWith("google", "gemini-2.5-pro");
    expect(fake.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: { provider: "google", id: "gemini-2.5-pro" } }),
    );
  });

  it("omits model (lets the SDK pick its own default) for an unparsable model string", async () => {
    const fake = fakeSdk();
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fake.loader);

    await deps.createAgentSession({ cwd: ctx.workingDirectory, model: "not-a-provider-id-pair", spawnEnv: {} });

    expect(fake.findModel).not.toHaveBeenCalled();
    expect(fake.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it("uses SessionManager.continueRecent when a sessionId is provided", async () => {
    const fake = fakeSdk();
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fake.loader);

    await deps.createAgentSession({ cwd: ctx.workingDirectory, sessionId: "resume-me", spawnEnv: {} });

    expect(fake.sessionManagerContinueRecent).toHaveBeenCalledWith(ctx.workingDirectory);
    expect(fake.sessionManagerCreate).not.toHaveBeenCalled();
  });

  it("uses SessionManager.create for a fresh session when no sessionId is provided", async () => {
    const fake = fakeSdk();
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fake.loader);

    await deps.createAgentSession({ cwd: ctx.workingDirectory, spawnEnv: {} });

    expect(fake.sessionManagerCreate).toHaveBeenCalledWith(ctx.workingDirectory);
    expect(fake.sessionManagerContinueRecent).not.toHaveBeenCalled();
  });

  it("passes a customTools bash tool whose spawnHook merges the given spawnEnv on top of the base env", async () => {
    const fake = fakeSdk();
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fake.loader);
    const spawnEnv = { ALOOK_PROXY_URL: "http://proxy" };

    await deps.createAgentSession({ cwd: ctx.workingDirectory, spawnEnv });

    expect(fake.createBashToolDefinition).toHaveBeenCalledWith(
      ctx.workingDirectory,
      expect.objectContaining({ spawnHook: expect.any(Function) }),
    );
    const { spawnHook } = fake.createBashToolDefinition.mock.calls[0][1] as {
      spawnHook: (c: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => { env: NodeJS.ProcessEnv };
    };
    const result = spawnHook({ command: "ls", cwd: "/tmp", env: { PATH: "/usr/bin" } });
    expect(result.env).toEqual({ PATH: "/usr/bin", ALOOK_PROXY_URL: "http://proxy" });
  });

  it("returns the sessionId from session.sessionId when createAgentSession doesn't return one directly", async () => {
    const fake = fakeSdk();
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fake.loader);

    const result = await deps.createAgentSession({ cwd: ctx.workingDirectory, spawnEnv: {} });

    expect(result.sessionId).toBe("sess-from-sdk");
  });

  it("throws a clear error when the SDK produces no sessionId at all", async () => {
    const fake = fakeSdk();
    fake.createAgentSession.mockResolvedValue({ session: {} });
    const ctx = baseCtx();
    const deps = createPiSdkDriverDeps(ctx, fake.loader);

    await expect(deps.createAgentSession({ cwd: ctx.workingDirectory, spawnEnv: {} })).rejects.toThrow(/sessionId/);
  });
});

describe("loadPiSdkModule — global-install fallback", () => {
  it("falls back to resolving + import()-ing the real install dir when the bare specifier isn't resolvable (never true in this test env)", async () => {
    // The package is never a real dependency of this workspace (see the
    // sibling detection tests in pi.test.ts), so `import("@earendil-works/
    // pi-coding-agent")` genuinely rejects here — this exercises the real
    // fallback path, not a mocked one.
    const pkgDir = path.join(mkTmp(), "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", main: "./dist/index.js" }));
    fs.writeFileSync(path.join(pkgDir, "dist", "index.js"), "export const MARKER = 'loaded-from-global-install';\n");

    vi.resetModules();
    vi.doMock("./pi.js", () => ({ resolvePiSdkPackageDir: () => pkgDir }));
    const fresh = await import("./piSdkDeps.js");

    const sdk = (await fresh.loadPiSdkModule()) as unknown as { MARKER: string };
    expect(sdk.MARKER).toBe("loaded-from-global-install");

    vi.doUnmock("./pi.js");
    vi.resetModules();
  });

  it("throws a clear error when pi isn't found on PATH either", async () => {
    vi.resetModules();
    vi.doMock("./pi.js", () => ({ resolvePiSdkPackageDir: () => undefined }));
    const fresh = await import("./piSdkDeps.js");

    await expect(fresh.loadPiSdkModule()).rejects.toThrow(/pi-coding-agent/);

    vi.doUnmock("./pi.js");
    vi.resetModules();
  });

  // Regression test: a failed load must NOT be memoized forever — a daemon
  // that started before the SDK was installed (or before PATH was fixed)
  // should be able to launch a pi agent on a later attempt without a
  // restart, once `resolvePiSdkPackageDir` starts succeeding.
  it("retries from scratch after a failed load instead of replaying the same rejection forever", async () => {
    const pkgDir = path.join(mkTmp(), "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", main: "./dist/index.js" }));
    fs.writeFileSync(path.join(pkgDir, "dist", "index.js"), "export const MARKER = 'loaded-from-global-install-retry';\n");

    vi.resetModules();
    let resolvable = false;
    vi.doMock("./pi.js", () => ({ resolvePiSdkPackageDir: () => (resolvable ? pkgDir : undefined) }));
    const fresh = await import("./piSdkDeps.js");

    await expect(fresh.loadPiSdkModule()).rejects.toThrow(/pi-coding-agent/);

    resolvable = true;
    const sdk = (await fresh.loadPiSdkModule()) as unknown as { MARKER: string };
    expect(sdk.MARKER).toBe("loaded-from-global-install-retry");

    vi.doUnmock("./pi.js");
    vi.resetModules();
  });
});

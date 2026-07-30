import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { prepareCliTransport, type CliTransportConfig } from "./cliTransport";
import { CredentialBroker } from "../credentials/credentialProxy";
import type { LaunchContext } from "../types";
import { makeRuntimeConfig } from "../runtimeConfig";

// The git-identity two-author split reads the HOST owner's `git config`
// (readHostGitIdentity) at spawn. That would make GIT_AUTHOR_* depend on
// whatever git identity the test machine happens to have — flaky across
// dev/CI. Mock the read to a controllable value; keep buildGitIdentityEnv
// real. Hoisted vi.mock is file-scoped (no cross-file leak). Default: no host
// identity → agent is both author+committer (the pre-two-author behavior the
// existing assertions expect); the two-author test overrides it.
const mockReadHostGitIdentity = vi.fn<() => { name?: string; email?: string } | null>(() => null);
vi.mock("./gitIdentityEnv.js", async (importActual) => {
  const actual = await importActual<typeof import("./gitIdentityEnv.js")>();
  return { ...actual, readHostGitIdentity: () => mockReadHostGitIdentity() };
});

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "clitransport-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function broker(): CredentialBroker {
  return new CredentialBroker({
    upstreamBaseUrl: "https://upstream.test",
    voucherDir: mkTmp(),
  });
}

function baseCtx(workingDirectory: string, overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    agentId: "agent_1",
    launchId: "launch_1",
    workingDirectory,
    standingPrompt: "",
    prompt: "",
    credentialProxy: { broker: broker(), proxyUrl: "http://127.0.0.1:9/proxy", runnerKey: "sk_agent_test", capabilities: ["send", "read"] },
    config: {},
    ...overrides,
  };
}

describe("prepareCliTransport — layered spawn env", () => {
  it("throws without a credential proxy (no plaintext fallback)", async () => {
    const ctx = baseCtx(mkTmp());
    delete (ctx as { credentialProxy?: unknown }).credentialProxy;
    await expect(prepareCliTransport(ctx, {}, undefined, "linux")).rejects.toThrow(/credentialProxy is required/);
  });

  it("throws a legible error when credentialProxy.capabilities is undefined (wiring bug)", async () => {
    const ctx = baseCtx(mkTmp(), {
      credentialProxy: {
        broker: broker(),
        proxyUrl: "http://127.0.0.1:9/proxy",
        runnerKey: "sk_agent_test",
      } as unknown as LaunchContext["credentialProxy"],
    });
    await expect(prepareCliTransport(ctx, {}, undefined, "linux")).rejects.toThrow(
      /credentialProxy\.capabilities is required/,
    );
  });

  it("throws when a capability entry contains a comma (would silently widen scope)", async () => {
    const ctx = baseCtx(mkTmp(), {
      credentialProxy: {
        broker: broker(),
        proxyUrl: "http://127.0.0.1:9/proxy",
        runnerKey: "sk_agent_test",
        capabilities: ["send,read"],
      },
    });
    await expect(prepareCliTransport(ctx, {}, undefined, "linux")).rejects.toThrow(
      /contains a comma/,
    );
  });

  it("accepts an empty capabilities array (legitimate zero-capability launch)", async () => {
    const cred = broker();
    const { spawnEnv, tokenFile } = await prepareCliTransport(
      baseCtx(mkTmp(), {
        credentialProxy: {
          broker: cred,
          proxyUrl: "http://127.0.0.1:9/proxy",
          runnerKey: "sk_agent_test",
          capabilities: [],
        },
      }),
      {},
      undefined,
      "linux",
    );
    // capabilities.join(",") on an empty array = "" → the env var is present
    // but empty, and the proxy reads that as "no capabilities granted".
    expect(spawnEnv.ALOOK_ACTIVE_CAPABILITIES).toBe("");
    // The minted voucher must reject every capability check (the Set is empty).
    const voucher = fs.readFileSync(tokenFile, "utf8");
    expect(cred.check(`Bearer ${voucher}`, "send").ok).toBe(false);
    expect(cred.check(`Bearer ${voucher}`, "attach").ok).toBe(false);
  });

  it("prepends the per-launch bin dir to PATH", async () => {
    const wd = mkTmp();
    const { spawnEnv, stateDir } = await prepareCliTransport(baseCtx(wd), {}, undefined, "linux");
    const first = (spawnEnv.PATH ?? "").split(path.delimiter)[0];
    expect(first).toBe(path.join(stateDir, "bin"));
  });

  it("injects the typed <PREFIX>_* contract + voucher path", async () => {
    const { spawnEnv, tokenFile } = await prepareCliTransport(baseCtx(mkTmp()), {}, undefined, "linux");
    expect(spawnEnv.ALOOK_ID).toBe("agent_1");
    expect(spawnEnv.ALOOK_CLI).toBe("alook");
    expect(spawnEnv.ALOOK_LAUNCH_ID).toBe("launch_1");
    expect(spawnEnv.ALOOK_PROXY_URL).toBe("http://127.0.0.1:9/proxy");
    expect(spawnEnv.ALOOK_PROXY_TOKEN_FILE).toBe(tokenFile);
  });

  it("provider-derived keys (protected) survive a colliding driver/user env", async () => {
    const ctx = baseCtx(mkTmp(), {
      config: {
        runtimeConfig: makeRuntimeConfig({
          runtime: "claude",
          provider: { kind: "custom", apiUrl: "https://endpoint.test", apiKey: "sk_provider" },
        }),
      },
    });
    // A driver layer trying to shadow the provider key must NOT win.
    const { spawnEnv } = await prepareCliTransport(ctx, { ANTHROPIC_API_KEY: "sk_spoofed" }, undefined, "linux");
    expect(spawnEnv.ANTHROPIC_BASE_URL).toBe("https://endpoint.test");
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe("sk_provider");
  });

  it("driver extraEnv (e.g. NO_COLOR) still applies when it doesn't collide", async () => {
    const { spawnEnv } = await prepareCliTransport(baseCtx(mkTmp()), { NO_COLOR: "1" }, undefined, "linux");
    expect(spawnEnv.NO_COLOR).toBe("1");
  });

  it("sets NO_COLOR=1 and FORCE_COLOR=0 by default, even without a driver setting them", async () => {
    const { spawnEnv } = await prepareCliTransport(baseCtx(mkTmp()), {}, undefined, "linux");
    expect(spawnEnv.NO_COLOR).toBe("1");
    expect(spawnEnv.FORCE_COLOR).toBe("0");
  });

  it("sets NO_PROXY for loopback", async () => {
    const { spawnEnv } = await prepareCliTransport(baseCtx(mkTmp()), {}, undefined, "linux");
    expect(spawnEnv.NO_PROXY).toContain("127.0.0.1");
    expect(spawnEnv.NO_PROXY).toContain("localhost");
  });

  it("injects per-agent GIT_AUTHOR_*/GIT_COMMITTER_* from the agent identity", async () => {
    const ctx = baseCtx(mkTmp(), {
      agentId: "a3f90c21beef",
      config: { agentName: "Melisa", agentDiscriminator: "1043" },
    });
    const { spawnEnv } = await prepareCliTransport(ctx, {}, undefined, "linux");
    expect(spawnEnv.GIT_AUTHOR_NAME).toBe("Melisa");
    expect(spawnEnv.GIT_AUTHOR_EMAIL).toBe("melisa.1043@alook.ai");
    expect(spawnEnv.GIT_COMMITTER_NAME).toBe("Melisa");
    expect(spawnEnv.GIT_COMMITTER_EMAIL).toBe(spawnEnv.GIT_AUTHOR_EMAIL);
  });

  it("falls back to a valid generic git identity when no agent name/discriminator is set", async () => {
    // config: {} (baseCtx default) — degraded/unknown-bot spawn with no name
    // and no discriminator, so identity falls back to the generic value.
    const { spawnEnv } = await prepareCliTransport(baseCtx(mkTmp()), {}, undefined, "linux");
    expect(spawnEnv.GIT_AUTHOR_NAME).toBe("Alook Agent");
    expect(spawnEnv.GIT_AUTHOR_EMAIL).toBe("alook-agent@alook.ai");
    expect(spawnEnv.GIT_AUTHOR_NAME).not.toBe("");
  });

  it("a driver trying to spoof GIT_AUTHOR_NAME does NOT win (gitIdentity precedence 35 > driver 30)", async () => {
    const ctx = baseCtx(mkTmp(), {
      agentId: "a3f90c21beef",
      config: { agentName: "Melisa", agentDiscriminator: "1043" },
    });
    const { spawnEnv } = await prepareCliTransport(ctx, { GIT_AUTHOR_NAME: "Someone Else" }, undefined, "linux");
    expect(spawnEnv.GIT_AUTHOR_NAME).toBe("Melisa");
  });

  it("two-author: host owner git identity ⇒ AUTHOR = owner, COMMITTER = agent", async () => {
    mockReadHostGitIdentity.mockReturnValueOnce({ name: "Gus", email: "gus@example.com" });
    const ctx = baseCtx(mkTmp(), {
      agentId: "a3f90c21beef",
      config: { agentName: "Melisa", agentDiscriminator: "1043" },
    });
    const { spawnEnv } = await prepareCliTransport(ctx, {}, undefined, "linux");
    // Author = the human owner (they wrote it), committer = the agent.
    expect(spawnEnv.GIT_AUTHOR_NAME).toBe("Gus");
    expect(spawnEnv.GIT_AUTHOR_EMAIL).toBe("gus@example.com");
    expect(spawnEnv.GIT_COMMITTER_NAME).toBe("Melisa");
    expect(spawnEnv.GIT_COMMITTER_EMAIL).toBe("melisa.1043@alook.ai");
  });

  it("creates a symlink when hostCliPath is set", async () => {
    const wd = mkTmp();
    const host = path.join(wd, "real.js");
    fs.writeFileSync(host, "#!/usr/bin/env node\n", { mode: 0o755 });
    const cli: CliTransportConfig = { cliName: "alook", envPrefix: "ALOOK", stateDirName: ".alook", hostCliPath: host };
    const { stateDir } = await prepareCliTransport(baseCtx(wd), {}, cli, "linux");
    const link = path.join(stateDir, "bin", "alook");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("revokes the agent's previous voucher before minting a new one on respawn", async () => {
    // Without this, every stop+respawn of the same agent leaves the OLD
    // voucher registered forever — an unbounded leak in the broker's map,
    // since revoke/revokeAgent is never called anywhere else in production
    // code (see plans/fix-credential-proxy-connection-leak.md).
    const cred = broker();
    const first = await prepareCliTransport(
      baseCtx(mkTmp(), { credentialProxy: { broker: cred, proxyUrl: "http://127.0.0.1:9/proxy", runnerKey: "sk_agent_test", capabilities: ["send", "read"] } }),
      {},
      undefined,
      "linux",
    );
    expect(cred.size).toBe(1);
    const firstVoucher = fs.readFileSync(first.tokenFile, "utf8");
    expect(cred.check(`Bearer ${firstVoucher}`).ok).toBe(true);

    const second = await prepareCliTransport(
      baseCtx(mkTmp(), { credentialProxy: { broker: cred, proxyUrl: "http://127.0.0.1:9/proxy", runnerKey: "sk_agent_test", capabilities: ["send", "read"] } }),
      {},
      undefined,
      "linux",
    );

    // Still exactly one live registration for this agent — the old one was
    // revoked, not left dangling, regardless of how many times it respawns.
    expect(cred.size).toBe(1);
    expect(cred.check(`Bearer ${firstVoucher}`).ok).toBe(false);
    const secondVoucher = fs.readFileSync(second.tokenFile, "utf8");
    expect(cred.check(`Bearer ${secondVoucher}`).ok).toBe(true);
  });

  it("mints the voucher with the capability set from the handoff", async () => {
    const cred = broker();
    const { tokenFile } = await prepareCliTransport(
      baseCtx(mkTmp(), {
        credentialProxy: {
          broker: cred,
          proxyUrl: "http://127.0.0.1:9/proxy",
          runnerKey: "sk_agent_test",
          capabilities: ["attach"],
        },
      }),
      {},
      undefined,
      "linux",
    );
    const voucher = fs.readFileSync(tokenFile, "utf8");
    expect(cred.check(`Bearer ${voucher}`, "attach").ok).toBe(true);
    expect(cred.check(`Bearer ${voucher}`, "send").ok).toBe(false);
  });

  it("does not revoke a DIFFERENT agent's voucher on respawn", async () => {
    const cred = broker();
    await prepareCliTransport(
      baseCtx(mkTmp(), {
        agentId: "agent_1",
        credentialProxy: { broker: cred, proxyUrl: "http://127.0.0.1:9/proxy", runnerKey: "sk_agent_test", capabilities: ["send", "read"] },
      }),
      {},
      undefined,
      "linux",
    );
    await prepareCliTransport(
      baseCtx(mkTmp(), {
        agentId: "agent_2",
        credentialProxy: { broker: cred, proxyUrl: "http://127.0.0.1:9/proxy", runnerKey: "sk_agent_test", capabilities: ["send", "read"] },
      }),
      {},
      undefined,
      "linux",
    );
    expect(cred.size).toBe(2);
  });
});

describe("prepareCliTransport — unified AGENTS.md packing", () => {
  it("writes AGENTS.md (+ CLAUDE.md symlink) into the workdir when standingPrompt is non-empty", async () => {
    const wd = mkTmp();
    await prepareCliTransport(baseCtx(wd, { standingPrompt: "You are an AI agent." }), {}, undefined, "linux");
    expect(fs.readFileSync(path.join(wd, "AGENTS.md"), "utf-8")).toBe("You are an AI agent.");
    expect(fs.lstatSync(path.join(wd, "CLAUDE.md")).isSymbolicLink()).toBe(true);
  });

  it("does not write AGENTS.md when standingPrompt is empty", async () => {
    const wd = mkTmp();
    await prepareCliTransport(baseCtx(wd), {}, undefined, "linux");
    expect(fs.existsSync(path.join(wd, "AGENTS.md"))).toBe(false);
  });

  it("every child-process driver gets the same file regardless of its own delivery mechanism", async () => {
    // Simulates what claude/kimi/codex/gemini/etc. all do: call prepareCliTransport
    // with a real standingPrompt before their driver-specific spawn logic.
    const wd = mkTmp();
    await prepareCliTransport(baseCtx(wd, { standingPrompt: "standing prompt content" }), { NO_COLOR: "1" }, undefined, "linux");
    expect(fs.readFileSync(path.join(wd, "AGENTS.md"), "utf-8")).toBe("standing prompt content");
  });
});

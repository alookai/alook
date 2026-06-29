import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { prepareCliTransport, type CliTransportConfig } from "./cliTransport";
import { CredentialBroker } from "../credentials/credentialProxy";
import type { LaunchContext } from "../types";
import { makeRuntimeConfig } from "../runtimeConfig";

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
    credentialProxy: { broker: broker(), proxyUrl: "http://127.0.0.1:9/proxy", runnerKey: "sk_agent_test" },
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

  it("sets NO_PROXY for loopback", async () => {
    const { spawnEnv } = await prepareCliTransport(baseCtx(mkTmp()), {}, undefined, "linux");
    expect(spawnEnv.NO_PROXY).toContain("127.0.0.1");
    expect(spawnEnv.NO_PROXY).toContain("localhost");
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
});

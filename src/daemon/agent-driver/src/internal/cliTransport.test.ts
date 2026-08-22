import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareCliTransport, type CliTransportConfig } from "./cliTransport.js";
import type { ClaudeConfig } from "../contract.js";
import type { AdapterLaunchContext } from "./adapter.js";
import { fakeLaunchContext, fakePrepared } from "../testing/adapter-fixture.js";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clitransport-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function baseCtx(workingDirectory: string, overrides: Partial<AdapterLaunchContext> = {}): AdapterLaunchContext {
  return fakeLaunchContext("claude", workingDirectory, {
    prepared: fakePrepared({
      base: { PATH: "/host/bin", KEEP: "base" },
      platformProtected: {
        ALOOK_ID: "agent_1",
        ALOOK_CLI: "alook",
        ALOOK_LAUNCH_ID: "launch_1",
      },
      networkProtected: {
        ALOOK_PROXY_URL: "http://127.0.0.1:9/proxy",
        NO_PROXY: "127.0.0.1,localhost",
      },
      credentialSensitive: { ALOOK_PROXY_TOKEN_FILE: "/tmp/voucher" },
    }),
    ...overrides,
  });
}

describe("prepareCliTransport", () => {
  it("prepends the per-launch bin dir to PATH", async () => {
    const { spawnEnv, stateDir } = await prepareCliTransport(baseCtx(mkTmp()), {}, undefined, "linux");
    expect((spawnEnv.PATH ?? "").split(path.delimiter)[0]).toBe(path.join(stateDir, "bin"));
  });

  it("injects the host-owned platform, network, and credential layers", async () => {
    const { spawnEnv, tokenFile } = await prepareCliTransport(baseCtx(mkTmp()), {}, undefined, "linux");
    expect(spawnEnv.ALOOK_ID).toBe("agent_1");
    expect(spawnEnv.ALOOK_CLI).toBe("alook");
    expect(spawnEnv.ALOOK_LAUNCH_ID).toBe("launch_1");
    expect(spawnEnv.ALOOK_PROXY_URL).toBe("http://127.0.0.1:9/proxy");
    expect(spawnEnv.ALOOK_PROXY_TOKEN_FILE).toBe(tokenFile);
  });

  it("provider-derived keys remain protected from driver and user environment", async () => {
    const runtimeConfig: ClaudeConfig = {
      model: { kind: "default" },
      provider: { kind: "custom_endpoint", apiUrl: "https://endpoint.test", apiKey: "sk_provider" },
      mode: "default",
      environment: { ANTHROPIC_API_KEY: "sk_user" },
    };
    const ctx = baseCtx(mkTmp(), { config: { runtimeConfig } });
    const { spawnEnv } = await prepareCliTransport(ctx, { ANTHROPIC_API_KEY: "sk_driver" }, undefined, "linux");
    expect(spawnEnv.ANTHROPIC_BASE_URL).toBe("https://endpoint.test");
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe("sk_provider");
  });

  it("preserves non-colliding base, user, and driver values", async () => {
    const runtimeConfig: ClaudeConfig = {
      model: { kind: "default" },
      provider: { kind: "default" },
      mode: "default",
      environment: { USER_VALUE: "user" },
    };
    const { spawnEnv } = await prepareCliTransport(
      baseCtx(mkTmp(), { config: { runtimeConfig } }),
      { DRIVER_VALUE: "driver" },
      undefined,
      "linux",
    );
    expect(spawnEnv).toMatchObject({ KEEP: "base", USER_VALUE: "user", DRIVER_VALUE: "driver" });
  });

  it("sets the color and loopback defaults from protected layers", async () => {
    const { spawnEnv } = await prepareCliTransport(baseCtx(mkTmp()), {}, undefined, "linux");
    expect(spawnEnv.NO_COLOR).toBe("1");
    expect(spawnEnv.FORCE_COLOR).toBe("0");
    expect(spawnEnv.NO_PROXY).toContain("127.0.0.1");
    expect(spawnEnv.NO_PROXY).toContain("localhost");
  });

  it("keeps host identity protected from a driver override", async () => {
    const ctx = baseCtx(mkTmp(), {
      prepared: fakePrepared({ identityProtected: { GIT_AUTHOR_NAME: "Melisa" } }),
    });
    const { spawnEnv } = await prepareCliTransport(ctx, { GIT_AUTHOR_NAME: "Someone Else" }, undefined, "linux");
    expect(spawnEnv.GIT_AUTHOR_NAME).toBe("Melisa");
  });

  it("creates a symlink when hostCliPath is set", async () => {
    const wd = mkTmp();
    const host = path.join(wd, "real.js");
    fs.writeFileSync(host, "#!/usr/bin/env node\n", { mode: 0o755 });
    const cli: CliTransportConfig = { cliName: "alook", envPrefix: "ALOOK", stateDirName: ".alook", hostCliPath: host };
    const { stateDir } = await prepareCliTransport(baseCtx(wd), {}, cli, "linux");
    expect(fs.lstatSync(path.join(stateDir, "bin", "alook")).isSymbolicLink()).toBe(true);
  });

  it("defaults hostCliPath from the prepared execution resource", async () => {
    const wd = mkTmp();
    const host = path.join(wd, "agent-cli.js");
    fs.writeFileSync(host, "#!/usr/bin/env node\n", { mode: 0o755 });
    const ctx = baseCtx(wd, { prepared: { ...fakePrepared(), executablePath: host } });
    const { stateDir } = await prepareCliTransport(ctx, {}, undefined, "linux");
    expect(fs.realpathSync(path.join(stateDir, "bin", "alook"))).toBe(fs.realpathSync(host));
  });

  it("does not write AGENTS.md for empty instructions", async () => {
    const wd = mkTmp();
    await prepareCliTransport(baseCtx(wd), {}, undefined, "linux");
    expect(fs.existsSync(path.join(wd, "AGENTS.md"))).toBe(false);
  });
});

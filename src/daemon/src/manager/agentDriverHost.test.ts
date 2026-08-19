import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CredentialBroker } from "../credentials/credentialProxy.js";
import type { HostLaunchContext } from "./hostContext.js";
import { createDaemonAgentDriverHost } from "./agentDriverHost.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "driver-host-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function context(
  broker: CredentialBroker,
  overrides: Partial<HostLaunchContext> = {},
): HostLaunchContext {
  return {
    agentId: "agent_1",
    launchId: "launch_1",
    workingDirectory: tmp(),
    standingPrompt: "",
    prompt: "",
    agentCliPath: process.execPath,
    credentialProxy: {
      broker,
      proxyUrl: "http://127.0.0.1:9/proxy",
      runnerKey: "runner-test",
      capabilities: ["send", "read"],
    },
    config: {},
    ...overrides,
  };
}

function broker(): CredentialBroker {
  return new CredentialBroker({ upstreamBaseUrl: "https://upstream.test", voucherDir: tmp() });
}

describe("createDaemonAgentDriverHost", () => {
  it("fails closed without a credential proxy", async () => {
    const ctx = context(broker());
    delete ctx.credentialProxy;
    expect(await createDaemonAgentDriverHost(ctx).prepareExecution({ backend: "claude", launchId: "l", workingDirectory: ctx.workingDirectory }))
      .toMatchObject({ ok: false, error: { code: "credential_proxy_required" } });
  });

  it("fails loudly when the daemon cannot resolve its agent CLI", async () => {
    const ctx = context(broker(), { agentCliPath: undefined });
    expect(await createDaemonAgentDriverHost(ctx).prepareExecution({ backend: "claude", launchId: "l", workingDirectory: ctx.workingDirectory }))
      .toMatchObject({ ok: false, error: { code: "agent_cli_required" } });
  });

  it("rejects missing and comma-containing capability lists", async () => {
    const first = context(broker());
    first.credentialProxy!.capabilities = undefined as never;
    expect(await createDaemonAgentDriverHost(first).prepareExecution({ backend: "claude", launchId: "l", workingDirectory: first.workingDirectory }))
      .toMatchObject({ ok: false, error: { code: "invalid_capabilities" } });
    const second = context(broker());
    second.credentialProxy!.capabilities = ["send,read"];
    expect(await createDaemonAgentDriverHost(second).prepareExecution({ backend: "claude", launchId: "l", workingDirectory: second.workingDirectory }))
      .toMatchObject({ ok: false, error: { code: "invalid_capabilities" } });
  });

  it("accepts an empty capability set and mints a zero-scope voucher", async () => {
    const cred = broker();
    const ctx = context(cred);
    ctx.credentialProxy!.capabilities = [];
    const result = await createDaemonAgentDriverHost(ctx).prepareExecution({ backend: "claude", launchId: "l", workingDirectory: ctx.workingDirectory });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resource.environmentLayers.platformProtected.ALOOK_ACTIVE_CAPABILITIES).toBe("");
    const voucher = fs.readFileSync(String(result.resource.environmentLayers.credentialSensitive.ALOOK_PROXY_TOKEN_FILE), "utf8");
    expect(cred.check(`Bearer ${voucher}`, "send").ok).toBe(false);
  });

  it("injects protected platform, runtime, network, identity, and credential layers", async () => {
    const cred = broker();
    const ctx = context(cred, {
      agentId: "a3f90c21beef",
      config: {
        agentName: "Melisa",
        agentDiscriminator: "1043",
        runtimeContext: {
          agentId: "a3f90c21beef", serverId: "srv", computerId: "pc", computerName: "Workstation",
          hostname: "host", os: "linux", daemonVersion: "1.2.3", workspacePath: "/work",
        },
      },
    });
    const result = await createDaemonAgentDriverHost(ctx).prepareExecution({ backend: "claude", launchId: "l", workingDirectory: ctx.workingDirectory });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.resource.environmentLayers.identityProtected).toMatchObject({
      GIT_COMMITTER_NAME: "Melisa",
      GIT_COMMITTER_EMAIL: "melisa.1043@alook.ai",
    });
    expect(result.resource.environmentLayers.platformProtected).toMatchObject({
      ALOOK_ID: "a3f90c21beef",
      ALOOK_LAUNCH_ID: "launch_1",
      ALOOK_ACTIVE_CAPABILITIES: "send,read",
    });
    expect(result.resource.environmentLayers.runtimeProtected).toMatchObject({ ALOOK_SERVER_ID: "srv", ALOOK_WORKSPACE_PATH: "/work" });
    expect(result.resource.environmentLayers.networkProtected.NO_PROXY).toContain("localhost");
    expect(result.resource.environmentLayers.credentialSensitive.ALOOK_PROXY_URL).toBe("http://127.0.0.1:9/proxy");
  });

  it("revokes the previous same-agent voucher before mint and release revokes the current one exactly once", async () => {
    const cred = broker();
    const ctx = context(cred);
    const first = await createDaemonAgentDriverHost(ctx).prepareExecution({ backend: "codex", launchId: "one", workingDirectory: ctx.workingDirectory });
    if (!first.ok) throw new Error(first.error.message);
    const firstVoucher = fs.readFileSync(String(first.resource.environmentLayers.credentialSensitive.ALOOK_PROXY_TOKEN_FILE), "utf8");
    expect(cred.check(`Bearer ${firstVoucher}`).ok).toBe(true);
    const second = await createDaemonAgentDriverHost(ctx).prepareExecution({ backend: "codex", launchId: "two", workingDirectory: ctx.workingDirectory });
    if (!second.ok) throw new Error(second.error.message);
    expect(cred.size).toBe(1);
    expect(cred.check(`Bearer ${firstVoucher}`).ok).toBe(false);
    const secondVoucher = fs.readFileSync(String(second.resource.environmentLayers.credentialSensitive.ALOOK_PROXY_TOKEN_FILE), "utf8");
    await second.resource.release({ reason: "normal", signal: new AbortController().signal, deadlineAt: Date.now() + 100 });
    expect(cred.check(`Bearer ${secondVoucher}`).ok).toBe(false);
  });

  it("does not revoke a different agent's voucher", async () => {
    const cred = broker();
    const one = context(cred, { agentId: "agent_1" });
    const two = context(cred, { agentId: "agent_2", launchId: "launch_2" });
    await createDaemonAgentDriverHost(one).prepareExecution({ backend: "claude", launchId: "one", workingDirectory: one.workingDirectory });
    await createDaemonAgentDriverHost(two).prepareExecution({ backend: "claude", launchId: "two", workingDirectory: two.workingDirectory });
    expect(cred.size).toBe(2);
  });
});

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSdkWorkerArtifact } from "../testing/sdk-worker-artifact.spec.js";
import type { SdkQuotaResult } from "./sdk-quota-worker.js";

const nativeRoot = process.env.ALOOK_NATIVE_SDK_ROOT;
let artifact: Awaited<ReturnType<typeof buildSdkWorkerArtifact>>;
beforeAll(async () => { if (nativeRoot) artifact = await buildSdkWorkerArtifact(); });
afterAll(() => artifact?.dispose());

describe.skipIf(!nativeRoot || process.platform === "win32")("official SDK machine quota contracts", () => {
  it.each([
    { backend: "copilot", packageName: "@github/copilot-sdk", fixture: "copilot-cli.mjs", plan: "pro", used: 20 },
    { backend: "qoder", packageName: "@qoder-ai/qoder-agent-sdk", fixture: "qoder-cli.mjs", plan: "Pro", used: 25 },
  ])("reads $backend through the official SDK without creating a model session", async ({ packageName, fixture, plan, used }) => {
    const root = mkdtempSync(join(tmpdir(), "alook-native-quota-"));
    const require = createRequire(join(resolve(nativeRoot!), "fixture.cjs"));
    const command = join(root, fixture);
    writeFileSync(command, readFileSync(new URL(`../testing/fixtures/sdk/${fixture}`, import.meta.url), "utf8").replace("#!/usr/bin/env node", `#!${process.execPath}`), { mode: 0o700 });
    const lane = new artifact.SdkWorkerLane(artifact.sdkQuotaWorker, { modulePath: require.resolve(packageName), cwd: root, config: { command }, probe: { includeModels: false } }, { ...process.env, QODER_PERSONAL_ACCESS_TOKEN: "fixture-token", QODER_CONFIG_DIR: root });
    try {
      const result = await lane.probe(15_000) as SdkQuotaResult;
      const requests = readdirSync(root).filter((name) => name === "qoder-requests").map((name) => readFileSync(join(root, name), "utf8"));
      expect(result.quota, JSON.stringify({ result, requests })).toMatchObject({ status: "available", planName: plan, limits: [{ usedPercent: used }] });
      expect(readdirSync(root).some((name) => /inputs|opens|history/.test(name))).toBe(false);
    } finally { await lane.stop({ forceAfterMs: 100 }); rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  it("times out and cleans its Qoder quota process while a separate bot keeps running", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-native-quota-isolation-"));
    const botRoot = mkdtempSync(join(tmpdir(), "alook-native-bot-isolation-"));
    const require = createRequire(join(resolve(nativeRoot!), "fixture.cjs"));
    const modulePath = require.resolve("@qoder-ai/qoder-agent-sdk");
    const command = join(root, "qoder.mjs");
    writeFileSync(command, readFileSync(new URL("../testing/fixtures/sdk/qoder-cli.mjs", import.meta.url), "utf8").replace("#!/usr/bin/env node", `#!${process.execPath}`), { mode: 0o700 });
    const env = { ...process.env, QODER_PERSONAL_ACCESS_TOKEN: "fixture-token", QODER_SERVICE_ACCOUNT_KEY: undefined, QODER_CONFIG_DIR: root };
    const bot = new artifact.SdkWorkerLane(artifact.qoderWorker, { modulePath, cwd: botRoot, config: { command, model: "native-fixture" } }, env);
    const quota = new artifact.SdkWorkerLane(artifact.sdkQuotaWorker, { modulePath, cwd: root, config: { command }, probe: { includeModels: false } }, { ...env, QUOTA_HANG: "1" });
    const events: string[] = [];
    bot.on("runtime_event", (event) => { events.push(event.kind); });
    try {
      expect(await bot.start({ text: "hold root", terminalOwner: "bot-root" })).toMatchObject({ ok: true });
      await expect(quota.probe(1_000)).rejects.toThrow("deadline");
      await quota.stop({ forceAfterMs: 100 });
      const quotaPid = Number(readFileSync(join(root, "qoder-pid"), "utf8"));
      const botPid = Number(readFileSync(join(botRoot, "qoder-pid"), "utf8"));
      expect(() => process.kill(quotaPid, 0)).toThrow();
      expect(() => process.kill(botPid, 0)).not.toThrow();
      writeFileSync(join(botRoot, "release"), "go");
      await vi.waitFor(() => expect(events).toContain("turn_end"));
    } finally { await quota.stop({ forceAfterMs: 100 }); await bot.stop({ forceAfterMs: 100 }); rmSync(root, { recursive: true, force: true }); rmSync(botRoot, { recursive: true, force: true }); }
  }, 15_000);
});

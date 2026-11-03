import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent, AgentSession, BuiltinBackendId, BuiltinBackendSpecs } from "../contract.js";
import { createAgentDriverSdkWithRegistry } from "../sdk.js";
import { capabilitiesFor, createAgentDriverRegistry, type AgentBackendRegistrationOf } from "../registry.js";
import { createFakeAgentDriverHost } from "../testing/fake-host.js";
import type { SdkWorkerFactory } from "../internal/sdk-worker-api.js";

import { buildSdkWorkerArtifact } from "../testing/sdk-worker-artifact.spec.js";

const nativeRoot = process.env.ALOOK_NATIVE_SDK_ROOT;
let artifact: Awaited<ReturnType<typeof buildSdkWorkerArtifact>>;
beforeAll(async () => { if (nativeRoot) artifact = await buildSdkWorkerArtifact(); });
afterAll(() => artifact?.dispose());
const roots: string[] = [];
const sessions: AgentSession<BuiltinBackendSpecs, BuiltinBackendId>[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop({ reason: "shutdown", forceAfterMs: 300 });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Native SDK fixture timed out: ${label}`);
}

const entries = [
  { id: "qoder", packageName: "@qoder-ai/qoder-agent-sdk", factory: "qoderWorker", commandFixture: "qoder-cli.mjs", model: "native-fixture", inputFile: "qoder-inputs" },
  { id: "copilot", packageName: "@github/copilot-sdk", factory: "copilotWorker", commandFixture: "copilot-cli.mjs", model: "native-fixture", inputFile: "copilot-inputs" },
  { id: "pi-durable", packageName: "@earendil-works/pi-durable", factory: "piDurableWorker", model: "faux/faux-1", inputFile: "native-requests" },
] as const;

function setup(entry: (typeof entries)[number]) {
  if (!nativeRoot) throw new Error("ALOOK_NATIVE_SDK_ROOT must point to the isolated npm prefix");
  const root = mkdtempSync(join(tmpdir(), `alook-native-${entry.id}-`));
  roots.push(root);
  const require = createRequire(join(resolve(nativeRoot), "fixture.cjs"));
  let modulePath = require.resolve(entry.packageName);
  let command: string | undefined;
  if ("commandFixture" in entry) {
    command = join(root, entry.commandFixture);
    const source = readFileSync(new URL(`../testing/fixtures/sdk/${entry.commandFixture}`, import.meta.url), "utf8");
    writeFileSync(command, source.replace("#!/usr/bin/env node", `#!${process.execPath}`), { mode: 0o700 });
  } else {
    const directory = mkdtempSync(join(resolve(nativeRoot), "alook-native-model-"));
    roots.push(directory);
    modulePath = join(directory, "fixture.mjs");
    writeFileSync(modulePath, readFileSync(new URL("../testing/fixtures/sdk/pi-harness.mjs", import.meta.url)));
  }
  const host = createFakeAgentDriverHost();
  const factory: SdkWorkerFactory = artifact[entry.factory];
  const sdk = createAgentDriverSdkWithRegistry<BuiltinBackendSpecs>({ host, registry: createAgentDriverRegistry([{
    id: entry.id,
    contractVersion: 2,
    capabilities: capabilitiesFor(entry.id),
    createAdapter: () => new artifact.OptionalSdkDriver(entry.id, entry.packageName, factory, () => ({ entry: modulePath }), { kind: "native" }),
  } as AgentBackendRegistrationOf<BuiltinBackendSpecs>]) });
  const open = async (resumeSessionId?: string) => {
    const opened = await sdk.open({ backend: entry.id, config: {
      model: { kind: "named", name: entry.model },
      command,
      provider: { kind: "default" },
      environment: { QODER_PERSONAL_ACCESS_TOKEN: "fixture-local-token" },
    }, launch: { workingDirectory: root, instructions: { format: "markdown", content: "Native fixture instructions" }, launchId: "native-test", resumeSessionId } });
    if (!opened.ok) throw new Error(opened.error.message);
    sessions.push(opened.session);
    const events: AgentEvent<BuiltinBackendSpecs, BuiltinBackendId>[] = [];
    void (async () => { for await (const event of opened.session.events) events.push(event); })();
    return { session: opened.session, events };
  };
  return { root, modulePath, command, open };
}

describe.skipIf(!nativeRoot || process.platform === "win32").each(entries)("$id with the installed official SDK and a local runtime", (entry) => {
  it("reuses a persistent context, delivers busy input, resumes and refuses missing history", { timeout: 25_000 }, async () => {
    const f = setup(entry);
    const { session, events } = await f.open();
    expect(await session.start({ id: "first", kind: "user", text: "hold first" })).toMatchObject({ status: "accepted" });
    const id = session.snapshot().backendSessionId;
    expect(typeof id).toBe("string");
    expect(await session.send({ id: "second", kind: "user", text: "second" })).toMatchObject({ status: "accepted", delivery: "steer" });
    writeFileSync(join(f.root, "release"), "go");
    await waitUntil(() => session.snapshot().state === "idle", "busy completion");
    expect(events.filter((event) => event.type === "turn_completed")).toEqual([
      expect.objectContaining({ commandIds: ["first", "second"], result: expect.objectContaining({ outcome: "success" }) }),
    ]);
    const inputs = readFileSync(join(f.root, entry.inputFile), "utf8");
    expect(inputs.indexOf("hold first")).toBeLessThan(inputs.indexOf("second"));
    if (entry.id === "copilot") expect(inputs).toContain('"mode":"immediate"');
    expect(await session.send({ id: "third", kind: "user", text: "third" })).toMatchObject({ status: "accepted" });
    await waitUntil(() => session.snapshot().state === "idle", "reuse completion");
    expect(session.snapshot().diagnostics.metrics.physicalOpenCount).toBe(1);
    await session.stop({ reason: "shutdown", forceAfterMs: 300 });
    const resumed = await f.open(id);
    expect(await resumed.session.start({ id: "resume", kind: "user", text: "resumed" })).toMatchObject({ status: "accepted" });
    await waitUntil(() => resumed.session.snapshot().state === "idle", "resume completion");
    expect(resumed.session.snapshot().diagnostics.metrics.resumeOutcome).toBe("resumed");
    await resumed.session.stop({ reason: "shutdown", forceAfterMs: 300 });
    const missing = await f.open("999999");
    expect(await missing.session.start({ id: "missing", kind: "user", text: "never sent" })).toMatchObject({ status: "rejected", error: { code: "reset_required" } });
    expect(readFileSync(join(f.root, entry.inputFile), "utf8")).not.toContain("never sent");
  });

  it("correlates interruption to the root and keeps the session reusable", { timeout: 20_000 }, async () => {
    const f = setup(entry);
    const { session, events } = await f.open();
    expect(await session.start({ id: "first", kind: "user", text: "hold interrupted" })).toMatchObject({ status: "accepted" });
    expect(await session.interrupt({ requestId: "interrupt", reason: "fixture" })).toMatchObject({ status: "accepted" });
    await waitUntil(() => session.snapshot().state === "idle", "interrupted root");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", result: expect.objectContaining({ outcome: "interrupted" }) }));
    writeFileSync(join(f.root, "release"), "go");
    expect(await session.send({ id: "after", kind: "user", text: "after interrupt" })).toMatchObject({ status: "accepted" });
    await waitUntil(() => session.snapshot().state === "idle", "next root");
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", result: { outcome: "success" } });
  });

  it("reads the native model catalog through the owned protocol worker", { timeout: 15_000 }, async () => {
    const f = setup(entry);
    const lane = new artifact.SdkWorkerLane(artifact[entry.factory], { cwd: f.root, modulePath: f.modulePath, config: { command: f.command }, probe: { includeModels: true } }, { ...process.env, QODER_PERSONAL_ACCESS_TOKEN: "fixture-local-token" });
    try {
      expect(await lane.probe()).toMatchObject({ status: "healthy", reasoning: { models: expect.arrayContaining([expect.objectContaining({ id: entry.id === "pi-durable" ? expect.any(String) : "native-fixture" })]) } });
    } finally { await lane.stop({ forceAfterMs: 300 }); }
  });
});


describe.skipIf(!nativeRoot || process.platform === "win32")("installed Copilot SDK request endings", () => {
  it("finishes a policy-blocked input without waiting for a user echo, then reuses the session", async () => {
    const f = setup(entries[1]);
    const { session, events } = await f.open();
    expect(await session.start({ id: "blocked", kind: "user", text: "policy blocked" })).toMatchObject({ status: "accepted" });
    await waitUntil(() => session.snapshot().state === "idle", "policy refusal");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", result: expect.objectContaining({ outcome: "failed" }) }));
    expect(await session.send({ id: "next", kind: "user", text: "allowed" })).toMatchObject({ status: "accepted" });
    await waitUntil(() => session.snapshot().state === "idle", "after policy refusal");
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", result: { outcome: "success" } });
    expect(session.snapshot().diagnostics.metrics.physicalOpenCount).toBe(1);
  });

  it.each(["blocked extra", "error extra"])("keeps the root healthy when %s arrives before its native send reply", async (text) => {
    const f = setup(entries[1]);
    const { session, events } = await f.open();
    await session.start({ id: "A", kind: "user", text: "hold root" });
    expect(await session.send({ id: "B", attemptId: "B-1", kind: "user", text })).toMatchObject({ status: "accepted", delivery: "steer" });
    await waitUntil(() => events.some(event => event.type === "command_returned" && event.input.commandId === "B"), "correlated refusal");
    expect(session.snapshot().state).toBe("working");
    expect(events).toContainEqual(expect.objectContaining({ type: "command_returned", input: { commandId: "B", attemptId: "B-1" }, evidence: text === "blocked extra" ? "explicitly_rejected" : "unknown", retryable: false }));
    writeFileSync(join(f.root, "release"), "go");
    await waitUntil(() => session.snapshot().state === "idle", "healthy root completion");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", commandIds: ["A"], result: expect.objectContaining({ outcome: "success" }) }));
  });

  it("keeps a recoverable model switch active until native idle and does not fail on unrelated warnings", async () => {
    const f = setup(entries[1]);
    const { session, events } = await f.open();
    expect(await session.start({ id: "switch", kind: "user", text: "hold auto switch" })).toMatchObject({ status: "accepted" });
    await waitUntil(() => events.some((event) => event.type === "diagnostic" && event.message === "Fixture model switching"), "model-switch diagnostic");
    expect(session.snapshot().state).toBe("working");
    expect(events.filter((event) => event.type === "turn_completed")).toEqual([]);
    writeFileSync(join(f.root, "release"), "go");
    await waitUntil(() => session.snapshot().state === "idle", "model-switch completion");
    expect(events.filter((event) => event.type === "turn_completed")).toEqual([
      expect.objectContaining({ commandIds: ["switch"], result: expect.objectContaining({ outcome: "success" }) }),
    ]);
  });
});

describe.skipIf(!nativeRoot)("installed Cursor SDK API", () => {
  it("loads persistent local agent APIs without opening a paid native run", async () => {
    const prefix = resolve(nativeRoot!);
    const require = createRequire(join(prefix, "fixture.cjs"));
    const lane = new artifact.SdkWorkerLane(artifact.cursorSdkWorker, {
      cwd: prefix, modulePath: require.resolve("@cursor/sdk"), config: {}, probe: { includeModels: false },
    }, { ...process.env });
    try { expect(await lane.probe()).toEqual({ status: "healthy" }); }
    finally { await lane.stop({ forceAfterMs: 300 }); }
  });
});

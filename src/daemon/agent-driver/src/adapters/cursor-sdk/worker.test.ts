import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentEvent, BuiltinBackendSpecs, RawOutputEvent } from "../../contract.js";
import { createAgentDriverSdkWithRegistry } from "../../sdk.js";
import { capabilitiesFor, createAgentDriverRegistry } from "../../registry.js";
import { createDefaultAgentDriverHost } from "../../host/default-host.js";
import { buildSdkWorkerArtifact } from "../../testing/sdk-worker-artifact.spec.js";
import { pathToFileURL } from "node:url";
import { cursorSdkWorker } from "./worker.js";

let artifact: Awaited<ReturnType<typeof buildSdkWorkerArtifact>>;
beforeAll(async () => { artifact = await buildSdkWorkerArtifact(); });
afterAll(() => artifact?.dispose());

const roots: string[] = [];
const ownedChildren = new Set<number>();
afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of ownedChildren) { try { process.kill(pid, "SIGKILL"); } catch { } }
  ownedChildren.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "alook cursor sdk "));
  roots.push(root);
  const modulePath = join(root, "fixture.mjs");
  writeFileSync(modulePath, readFileSync(new URL("../../testing/fixtures/sdk/cursor-sdk.mjs", import.meta.url)));
  const registration = {
    id: "cursor-sdk" as const, contractVersion: 2 as const, capabilities: capabilitiesFor("cursor-sdk"),
    createAdapter: () => new artifact.OptionalSdkDriver("cursor-sdk", "fixture-sdk", artifact.cursorSdkWorker, () => ({ entry: modulePath, version: "fixture" })),
  };
  const rawOutput: RawOutputEvent[] = [];
  const host = {
    ...createDefaultAgentDriverHost({ onRawOutput: (event) => { rawOutput.push(event); } }),
    rawOutput,
  };
  const sdk = createAgentDriverSdkWithRegistry<BuiltinBackendSpecs>({ host, registry: createAgentDriverRegistry([registration]) });
  const open = (resumeSessionId?: string) => sdk.open({ backend: "cursor-sdk", config: { model: { kind: "named", name: "fixture-model" } }, launch: {
    workingDirectory: root, instructions: { format: "markdown", content: "fixture instructions" }, launchId: "fixture", resumeSessionId,
  } });
  return { root, sdk, open, host };
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Fixture did not reach the expected state");
}

describe("Cursor SDK public sessions through an owned worker", () => {
  it("keeps one worker across turns and queues undelivered steering for the next turn", async () => {
    const f = setup();
    const opened = await f.open();
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.session;
    const events: AgentEvent<BuiltinBackendSpecs, "cursor-sdk">[] = [];
    const collecting = (async () => { for await (const event of session.events) events.push(event); })();
    let phase = "first admission";
    let current = session;
    const admissionTimings: Record<string, number> = {};
    const firstStartedAt = Date.now();
    let resumeStartedAt: number | undefined;
    onTestFailed(() => {
      const fixture = Object.fromEntries(["opens", "inputs", "steers", "fixture-history", "release"].map((name) => {
        const path = join(f.root, name);
        return [name, existsSync(path) ? readFileSync(path, "utf8") : null];
      }));
      console.error(JSON.stringify({ phase, admissionTimings, resumeWaitMs: resumeStartedAt === undefined ? null : Date.now() - resumeStartedAt,
        snapshot: current.snapshot(), events: events.slice(-20), rawOutput: f.host.rawOutput, fixture }));
    });
    try {
      const receipt = await session.start({ id: "root", kind: "user", text: "first" });
      admissionTimings.firstMs = Date.now() - firstStartedAt;
      expect(receipt, JSON.stringify({ receipt, rawOutput: f.host.rawOutput })).toMatchObject({ status: "accepted" });
      phase = "busy steering refusal";
      expect(await session.send({ id: "steer", kind: "user", text: "refuse" })).toMatchObject({ status: "queued", reason: "runtime_busy" });
      writeFileSync(join(f.root, "release"), "go");
      phase = "queued turn completion";
      await waitUntil(() => events.some(event => event.type === "turn_completed" && event.commandIds.includes("steer")) && session.snapshot().state === "idle");
      expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", result: expect.objectContaining({ outcome: "success" }) }));
      phase = "next turn admission";
      await session.send({ id: "next", kind: "user", text: "second" });
      phase = "next turn completion";
      await waitUntil(() => session.snapshot().state === "idle");
      expect(readFileSync(join(f.root, "opens"), "utf8").trim().split("\n")).toHaveLength(1);
      expect(readFileSync(join(f.root, "inputs"), "utf8")).toBe("first\nrefuse\nsecond\n");
    } finally {
      phase = `shutdown after ${phase}`;
      await session.stop({ reason: "shutdown", forceAfterMs: 100 });
      phase = "event stream shutdown";
      await collecting;
    }
    phase = "resume open";
    const resumed = await f.open("fixture-agent");
    if (!resumed.ok) throw new Error(resumed.error.message);
    current = resumed.session;
    try {
      phase = "resume admission";
      resumeStartedAt = Date.now();
      await resumed.session.start({ id: "resume", kind: "user", text: "third" });
      admissionTimings.resumeMs = Date.now() - resumeStartedAt;
      console.info(JSON.stringify({ cursorWorkerAdmissionTimings: admissionTimings }));
      expect(resumed.session.snapshot().diagnostics.metrics.resumeOutcome).toBe("resumed");
    } finally {
      phase = `resume shutdown after ${phase}`;
      await resumed.session.stop({ reason: "shutdown", forceAfterMs: 100 });
    }
  });

  it.skipIf(process.platform === "win32")("stops a real detached tool descendant with its exact worker", async () => {
    const f = setup();
    const opened = await f.open();
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.session;
    try {
      const receipt = await session.start({ id: "root", kind: "user", text: "spawn" });
      expect(receipt, JSON.stringify(f.host.rawOutput)).toMatchObject({ status: "accepted" });
      const pid = Number(readFileSync(join(f.root, "child-pid"), "utf8"));
      ownedChildren.add(pid);
      expect(() => process.kill(pid, 0)).not.toThrow();
      await session.stop({ reason: "shutdown", forceAfterMs: 100 });
      expect(() => process.kill(pid, 0)).toThrow();
      ownedChildren.delete(pid);
    } finally { await session.stop({ reason: "shutdown", forceAfterMs: 100 }); }
  });

  it("checks installation without opening a native session or reading the model catalog", async () => {
    const f = setup();
    expect(await f.sdk.probe({ backend: "cursor-sdk", includeModels: false })).toMatchObject({ status: "healthy", version: "fixture" });
    expect(await f.sdk.probe({ backend: "cursor-sdk" })).toMatchObject({ status: "healthy", reasoning: { models: [{ id: "fixture-model" }] } });
    expect(() => readFileSync(join(f.root, "opens"))).toThrow();
  });
});

describe("Cursor SDK source probes", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "Function").mockImplementationOnce(function () {
      return (url: string) => import(url);
    } as unknown as FunctionConstructor);
  });
  it("reads the catalog without creating a native session", async () => {
    const f = setup();
    expect(await cursorSdkWorker({ moduleUrl: pathToFileURL(join(f.root, "fixture.mjs")).href, cwd: f.root, config: {}, probe: { includeModels: true } }, () => {})).toMatchObject({ status: "healthy", reasoning: { models: expect.arrayContaining([expect.objectContaining({ id: "fixture-model" })]) } });
    expect(() => readFileSync(join(f.root, "opens"))).toThrow();
  });

  it("rejects an SDK missing the persistent local API", async () => {
    const f = setup();
    const modulePath = join(f.root, "incompatible.mjs");
    writeFileSync(modulePath, "export const Agent = {};\n");
    await expect(cursorSdkWorker({ moduleUrl: pathToFileURL(modulePath).href, cwd: f.root, config: {}, probe: { includeModels: false } }, () => {})).rejects.toMatchObject({ code: "incompatible_configuration" });
  });
});

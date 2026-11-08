import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SdkWorkerLane } from "./sdk-worker-lane.js";
import type { SdkWorkerFactory } from "./sdk-worker-api.js";
import type { AdapterEvent } from "./adapter.js";

import { buildSdkWorkerArtifact } from "../testing/sdk-worker-artifact.spec.js";

let artifact: Awaited<ReturnType<typeof buildSdkWorkerArtifact>>;
beforeAll(async () => { artifact = await buildSdkWorkerArtifact(); });
afterAll(() => artifact?.dispose());

const roots: string[] = [];
const lanes: SdkWorkerLane[] = [];
afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.stop({ forceAfterMs: 100 });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function worker(factory: SdkWorkerFactory): SdkWorkerLane {
  const cwd = mkdtempSync(join(tmpdir(), "alook-worker-protocol-"));
  roots.push(cwd);
  const lane = new artifact.SdkWorkerLane(factory, { modulePath: "unused", cwd, config: {}, probe: { includeModels: false } }, { ...process.env });
  lanes.push(lane);
  return lane;
}

describe("owned SDK worker transport", () => {
  it("imports a native filesystem entry with spaces, Unicode, percent and fragment characters", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "alook SDK €€ #%-"));
    roots.push(cwd);
    const modulePath = join(cwd, "sdk #%.mjs");
    writeFileSync(modulePath, "export const status = 'healthy';\n");
    const lane = new artifact.SdkWorkerLane(async (init) => {
      if (!init.moduleUrl.startsWith("file:")) throw new Error("Expected a file URL");
      const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
      return { status: (await load(init.moduleUrl)).status };
    }, { modulePath, cwd, config: {}, probe: { includeModels: false } }, { ...process.env });
    lanes.push(lane);
    expect(await lane.probe()).toEqual({ status: "healthy" });
  });

  it("preserves UTF-8 text and stderr across individual byte boundaries", async () => {
    const lane = worker(async () => {
      const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
      const { writeSync } = await load("node:fs");
      const line = Buffer.from(`${JSON.stringify({ event: { kind: "assistant_message_delta", text: "€€😀" } })}\n`);
      for (const byte of line) {
        writeSync(1, Buffer.from([byte]));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      for (const byte of Buffer.from("₿₩😀")) {
        writeSync(2, Buffer.from([byte]));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return { status: "healthy" };
    });
    const events: AdapterEvent[] = [];
    let stderr = "";
    lane.on("runtime_event", (event) => events.push(event));
    const stderrComplete = new Promise<void>((resolve) => {
      lane.on("stderr", (text) => {
        stderr += text;
        if (Buffer.byteLength(stderr) >= Buffer.byteLength("₿₩😀")) resolve();
      });
    });
    expect(await lane.probe()).toEqual({ status: "healthy" });
    await stderrComplete;
    expect(events).toEqual([{ kind: "assistant_message_delta", text: "€€😀" }]);
    expect(stderr).toBe("₿₩😀");
  });

  it("preserves stdout write encoding, callbacks and backpressure return type", async () => {
    const lane = worker(async () => {
      await new Promise<void>((resolve, reject) => {
        const writable = process.stdout.write("€€€😀", "utf8", (error) => error ? reject(error) : resolve());
        if (typeof writable !== "boolean") reject(new Error("Lost native write return value"));
      });
      await new Promise<void>((resolve, reject) => {
        process.stdout.write("€€€", (error) => error ? reject(error) : resolve());
      });
      return { status: "healthy" };
    });
    let stderr = "";
    const stderrComplete = new Promise<void>((resolve) => {
      lane.on("stderr", (text) => {
        stderr += text;
        if (Buffer.byteLength(stderr) >= Buffer.byteLength("€€€😀€€€")) resolve();
      });
    });
    expect(await lane.probe()).toEqual({ status: "healthy" });
    await stderrComplete;
    expect(stderr).toBe("€€€😀€€€");
  });
});

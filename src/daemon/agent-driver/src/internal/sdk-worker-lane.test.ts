import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SdkWorkerLane } from "./sdk-worker-lane.js";
import type { SdkWorkerFactory } from "./sdk-worker-api.js";
import type { AdapterEvent } from "./adapter.js";

const roots: string[] = [];
const lanes: SdkWorkerLane[] = [];
afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.stop({ forceAfterMs: 100 });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function worker(factory: SdkWorkerFactory): SdkWorkerLane {
  const cwd = mkdtempSync(join(tmpdir(), "alook-worker-protocol-"));
  roots.push(cwd);
  const lane = new SdkWorkerLane(factory, { modulePath: "unused", cwd, config: {}, probe: { includeModels: false } }, { ...process.env });
  lanes.push(lane);
  return lane;
}

describe("owned SDK worker transport", () => {
  it("imports a native filesystem entry with spaces, Unicode, percent and fragment characters", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "alook SDK 你好 #%-"));
    roots.push(cwd);
    const modulePath = join(cwd, "sdk #%.mjs");
    writeFileSync(modulePath, "export const status = 'healthy';\n");
    const lane = new SdkWorkerLane(async (init) => {
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
      const line = Buffer.from(`${JSON.stringify({ event: { kind: "assistant_message_delta", text: "你好😀" } })}\n`);
      for (const byte of line) {
        writeSync(1, Buffer.from([byte]));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      for (const byte of Buffer.from("日志😀")) {
        writeSync(2, Buffer.from([byte]));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return { status: "healthy" };
    });
    const events: AdapterEvent[] = [];
    let stderr = "";
    lane.on("runtime_event", (event) => events.push(event));
    lane.on("stderr", (text) => { stderr += text; });
    expect(await lane.probe()).toEqual({ status: "healthy" });
    expect(events).toEqual([{ kind: "assistant_message_delta", text: "你好😀" }]);
    expect(stderr).toBe("日志😀");
  });

  it("preserves stdout write encoding, callbacks and backpressure return type", async () => {
    const lane = worker(async () => {
      await new Promise<void>((resolve, reject) => {
        const writable = process.stdout.write("带编码😀", "utf8", (error) => error ? reject(error) : resolve());
        if (typeof writable !== "boolean") reject(new Error("Lost native write return value"));
      });
      await new Promise<void>((resolve, reject) => {
        process.stdout.write("带回调", (error) => error ? reject(error) : resolve());
      });
      return { status: "healthy" };
    });
    let stderr = "";
    lane.on("stderr", (text) => { stderr += text; });
    expect(await lane.probe()).toEqual({ status: "healthy" });
    expect(stderr).toBe("带编码😀带回调");
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PII_SOURCE_MAX_BYTES } from "@alook/shared";

const state = vi.hoisted(() => ({ fail: false, stall: false, malformed: false, workers: [] as Array<{ terminate: () => Promise<number> }> }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    constructor() {
      super();
      if (state.fail) throw new Error("PRIVATE_WORKER_FAILURE");
      state.workers.push(this);
      queueMicrotask(() => this.emit("message", { ready: true }));
    }
    ref() { return this; }
    unref() { return this; }
    terminate = vi.fn(async () => 0);
    postMessage(message: { taskId: number; text: string; plugins: Array<{ id: string }> }) {
      queueMicrotask(() => this.emit("message", state.malformed ? { taskId: message.taskId } : state.stall
        ? { taskId: message.taskId, active: message.plugins[0]!.id }
        : { taskId: message.taskId, text: message.text, triggers: [] }));
    }
  } };
});
import { compilePiiSource, PiiRunner } from "./evaluator.js";
const runners: PiiRunner[] = [];
const plugins = [{ id: "fixture", code: "fixture" }];
beforeEach(() => { state.fail = false; state.stall = false; state.malformed = false; state.workers.splice(0); });
afterEach(async () => { await Promise.all(runners.splice(0).map(runner => runner.close())); vi.useRealTimers(); });

it("rejects oversized and invalid source before execution", () => {
  expect(() => compilePiiSource("x".repeat(PII_SOURCE_MAX_BYTES + 1))).toThrow("PII_SOURCE_TOO_LARGE");
  expect(() => compilePiiSource("export default (")).toThrow("PII_INVALID_SOURCE");
});

it("fails safely when a worker cannot start and permits a subsequent retry", async () => {
  const runner = new PiiRunner(); runners.push(runner);
  state.fail = true;
  await expect(runner.evaluate(plugins, "PRIVATE_SAMPLE")).rejects.toMatchObject({ message: "PII_UNAVAILABLE", code: "PII_UNAVAILABLE" });
  state.fail = false;
  expect(await runner.evaluate(plugins, "recovered")).toBe("recovered");
});

it("terminates an unresponsive worker at the parent deadline and recovers the next evaluation", async () => {
  vi.useFakeTimers();
  state.stall = true;
  const runner = new PiiRunner(); runners.push(runner);
  const pending = runner.evaluate(plugins, "PRIVATE_SAMPLE");
  const rejected = expect(pending).rejects.toMatchObject({ code: "PII_PLUGIN_TIMEOUT", pluginId: "fixture" });
  await vi.advanceTimersByTimeAsync(251);
  await rejected;
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
  state.stall = false;
  const recovered = runner.evaluate(plugins, "recovered");
  await vi.advanceTimersByTimeAsync(0);
  expect(await recovered).toBe("recovered");
  expect(state.workers).toHaveLength(2);
});

it("rejects a malformed worker reply instead of returning an unverified output", async () => {
  state.malformed = true;
  const runner = new PiiRunner(); runners.push(runner);
  await expect(runner.evaluate(plugins, "PRIVATE_SAMPLE")).rejects.toMatchObject({ code: "PII_PLUGIN_FAILED" });
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
  state.malformed = false;
  expect(await runner.evaluate(plugins, "recovered")).toBe("recovered");
});

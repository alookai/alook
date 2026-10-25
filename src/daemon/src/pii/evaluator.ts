import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { transform } from "sucrase";
import { PII_SOURCE_MAX_BYTES } from "@alook/shared";

export class PiiError extends Error {
  constructor(readonly code: string, readonly pluginId?: string) {
    super(pluginId ? `${code}: ${pluginId}` : code);
  }
}

export function compilePiiSource(source: string): string {
  if (Buffer.byteLength(source, "utf8") > PII_SOURCE_MAX_BYTES) throw new PiiError("PII_SOURCE_TOO_LARGE");
  try {
    return transform(source, { transforms: ["typescript", "imports"], disableESTransforms: true }).code;
  } catch {
    throw new PiiError("PII_INVALID_SOURCE");
  }
}

const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { getQuickJS } = require(workerData.enginePath);
getQuickJS().then(engine => {
  parentPort.on("message", ({ taskId, plugins, text: input }) => {
  const send = message => parentPort.postMessage({ ...message, taskId });
  let text = input;
  for (const plugin of plugins) {
    const runtime = engine.newRuntime();
    runtime.setMemoryLimit(8 * 1024 * 1024);
    runtime.setMaxStackSize(256 * 1024);
    const deadline = Date.now() + 100;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const context = runtime.newContext();
    let result;
    try {
      send({ active: plugin.id });
      const program = '(function(){"use strict";const exports={};\n' + plugin.code +
        '\nif(typeof exports.default!=="function")throw 0;return exports.default(' + JSON.stringify(text) + ');})()';
      result = context.evalCode(program);
      if (result.error) throw 0;
      if (context.typeof(result.value) !== "string") {
        send({ error: "PII_INVALID_RESULT", pluginId: plugin.id });
        return;
      }
      text = context.getString(result.value);
      if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
        send({ error: "PII_OUTPUT_TOO_LARGE", pluginId: plugin.id });
        return;
      }
    } catch {
      send({ error: "PII_PLUGIN_FAILED", pluginId: plugin.id });
      return;
    } finally {
      if (result) (result.error || result.value).dispose();
      context.dispose();
      runtime.dispose();
    }
  }
  send({ text });
  });
  parentPort.postMessage({ ready: true });
}).catch(() => parentPort.postMessage({ error: "PII_UNAVAILABLE" }));
`;

type CompiledPlugin = { id: string; code: string };

export class PiiRunner {
  private worker: Worker | undefined;
  private ready = false;
  private closed = false;
  private pending = 0;
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();

  evaluate(plugins: readonly CompiledPlugin[], text: string): Promise<string> {
    if (this.closed || this.pending >= 32) return Promise.reject(new PiiError("PII_UNAVAILABLE"));
    this.pending++;
    return new Promise((resolve, reject) => {
      let waiting = true;
      const timeout = setTimeout(() => {
        if (!waiting) return;
        waiting = false;
        this.pending--;
        reject(new PiiError("PII_UNAVAILABLE"));
      }, 3_000);
      this.tail = this.tail.then(async () => {
        if (!waiting) return;
        waiting = false;
        this.pending--;
        clearTimeout(timeout);
        if (this.closed) { reject(new PiiError("PII_UNAVAILABLE")); return; }
        try { resolve(plugins.length === 0 ? text : await this.execute(plugins, text)); }
        catch (error) { reject(error); }
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.worker?.terminate();
    await this.tail;
  }

  private execute(plugins: readonly CompiledPlugin[], text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let worker = this.worker;
      if (!worker) {
        try {
          worker = new Worker(workerSource, {
            eval: true,
            workerData: { enginePath: createRequire(import.meta.url).resolve("quickjs-emscripten") },
            resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
          });
          this.worker = worker;
          const clear = () => {
            if (this.worker === worker) { this.worker = undefined; this.ready = false; }
          };
          worker.on("error", clear);
          worker.on("exit", clear);
        } catch { reject(new PiiError("PII_UNAVAILABLE")); return; }
      }
      const current = worker;
      const taskId = ++this.sequence;
      current.ref();
      let finished = false;
      let active: string | undefined;
      let deadline: ReturnType<typeof setTimeout>;
      const finish = (error?: PiiError, output?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        current.off("message", onMessage);
        current.off("error", onError);
        current.off("exit", onError);
        if (error) {
          if (this.worker === current) { this.worker = undefined; this.ready = false; }
          void current.terminate().then(() => reject(error));
        } else {
          current.unref();
          resolve(output!);
        }
      };
      const arm = (milliseconds: number) => {
        clearTimeout(deadline);
        deadline = setTimeout(() => finish(new PiiError("PII_PLUGIN_TIMEOUT", active)), milliseconds);
      };
      const start = () => { arm(250); current.postMessage({ taskId, plugins, text }); };
      const onError = () => finish(new PiiError("PII_PLUGIN_FAILED", active));
      const onMessage = (message: { taskId?: number; ready?: boolean; active?: string; error?: string; pluginId?: string; text?: string }) => {
        if (message.ready) { this.ready = true; start(); }
        else if (!this.ready && message.error === "PII_UNAVAILABLE") finish(new PiiError("PII_UNAVAILABLE"));
        else if (message.taskId !== taskId) return;
        else if (message.active !== undefined) { active = message.active; arm(250); }
        else if (message.error !== undefined) finish(new PiiError(message.error, message.pluginId));
        else if (typeof message.text === "string") finish(undefined, message.text);
        else onError();
      };
      current.on("message", onMessage);
      current.on("error", onError);
      current.on("exit", onError);
      if (this.ready) start();
      else arm(3_000);
    });
  }
}

export async function evaluatePii(plugins: readonly CompiledPlugin[], text: string): Promise<string> {
  const runner = new PiiRunner();
  try { return await runner.evaluate(plugins, text); }
  finally { await runner.close(); }
}

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
  let text = workerData.text;
  for (const plugin of workerData.plugins) {
    const runtime = engine.newRuntime();
    runtime.setMemoryLimit(8 * 1024 * 1024);
    runtime.setMaxStackSize(256 * 1024);
    const deadline = Date.now() + 100;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const context = runtime.newContext();
    let result;
    try {
      parentPort.postMessage({ active: plugin.id });
      const program = '(function(){"use strict";const exports={};\n' + plugin.code +
        '\nif(typeof exports.default!=="function")throw 0;return exports.default(' + JSON.stringify(text) + ');})()';
      result = context.evalCode(program);
      if (result.error) throw 0;
      if (context.typeof(result.value) !== "string") {
        parentPort.postMessage({ error: "PII_INVALID_RESULT", pluginId: plugin.id });
        return;
      }
      text = context.getString(result.value);
      if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
        parentPort.postMessage({ error: "PII_OUTPUT_TOO_LARGE", pluginId: plugin.id });
        return;
      }
    } catch {
      parentPort.postMessage({ error: "PII_PLUGIN_FAILED", pluginId: plugin.id });
      return;
    } finally {
      if (result) (result.error || result.value).dispose();
      context.dispose();
      runtime.dispose();
    }
  }
  parentPort.postMessage({ text });
}).catch(() => parentPort.postMessage({ error: "PII_UNAVAILABLE" }));
`;

export function evaluatePii(plugins: readonly { id: string; code: string }[], text: string): Promise<string> {
  if (plugins.length === 0) return Promise.resolve(text);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerSource, {
        eval: true,
        workerData: { plugins, text, enginePath: createRequire(import.meta.url).resolve("quickjs-emscripten") },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      });
    } catch {
      reject(new PiiError("PII_UNAVAILABLE"));
      return;
    }
    let finished = false;
    let active: string | undefined;
    let deadline: ReturnType<typeof setTimeout>;
    const finish = (error?: PiiError, output?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      void worker.terminate().then(() => error ? reject(error) : resolve(output!));
    };
    const arm = (milliseconds: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => finish(new PiiError("PII_PLUGIN_TIMEOUT", active)), milliseconds);
    };
    arm(3_000);
    worker.on("message", (message: { active?: string; error?: string; pluginId?: string; text?: string }) => {
      if (message.active !== undefined) {
        active = message.active;
        arm(250);
      } else if (message.error !== undefined) {
        finish(new PiiError(message.error, message.pluginId));
      } else if (typeof message.text === "string") {
        finish(undefined, message.text);
      } else {
        finish(new PiiError("PII_PLUGIN_FAILED", active));
      }
    });
    worker.on("error", () => finish(new PiiError("PII_PLUGIN_FAILED", active)));
    worker.on("exit", () => { if (!finished) finish(new PiiError("PII_PLUGIN_FAILED", active)); });
  });
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PiiPluginSchema, PiiPreviewTextSchema, PiiErrorCodeSchema, PII_MAX_PLUGINS, PII_SOURCE_MAX_BYTES, PII_TEXT_MAX_BYTES, type PiiLocalRequest, type PiiOperation, type PiiResult, type PiiSnapshot } from "@alook/shared";
import { PII_DEFAULTS } from "./defaults.js";
import { compilePiiSource, PiiError, PiiRunner } from "./evaluator.js";

const storedPlugin = PiiPluginSchema.extend({ source: z.string().min(1).max(PII_SOURCE_MAX_BYTES) });
const storedPipeline = z.strictObject({ version: z.literal(1), revision: z.number().int().nonnegative(), plugins: z.array(storedPlugin).max(PII_MAX_PLUGINS) });
type Pipeline = z.infer<typeof storedPipeline>;

export class PiiStore {
  private readonly runner = new PiiRunner();
  private readonly pipelines = new Map<string, Pipeline>();
  private readonly compiled = new WeakMap<Pipeline, readonly { id: string; code: string }[]>();
  constructor(private readonly directory: string) {}

  close(): Promise<void> { return this.runner.close(); }

  private directoryFor(botId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(botId)) throw new PiiError("PII_INVALID_REQUEST");
    return join(this.directory, botId, "pii");
  }

  private read(botId: string, persist = true): Pipeline {
    const directory = this.directoryFor(botId);
    const cached = this.pipelines.get(botId);
    if (cached) return cached;
    if (!existsSync(directory)) {
      const created: Pipeline = { version: 1, revision: 0, plugins: PII_DEFAULTS.map((plugin) => ({ ...plugin, enabled: true })) };
      if (persist) this.save(botId, created);
      return created;
    }
    try {
      const file = join(directory, "pipelines.json");
      if (statSync(file).size > 16 * 1024 * 1024) throw 0;
      const pipeline = storedPipeline.parse(JSON.parse(readFileSync(file, "utf8")));
      this.pipelines.set(botId, pipeline);
      return pipeline;
    } catch {
      throw new PiiError("PII_CONFIG_UNAVAILABLE");
    }
  }

  private save(botId: string, pipeline: Pipeline): void {
    const directory = this.directoryFor(botId);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      writeFileSync(temporary, JSON.stringify(pipeline), { mode: 0o600, flag: "wx" });
      renameSync(temporary, join(directory, "pipelines.json"));
      this.pipelines.set(botId, pipeline);
    } catch {
      throw new PiiError("PII_CONFIG_UNAVAILABLE");
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private snapshot(pipeline: Pipeline): PiiSnapshot {
    return {
      revision: pipeline.revision,
      plugins: pipeline.plugins.map(({ id, name, description, enabled }) => ({ id, name, description, enabled })),
    };
  }

  list(botId: string): PiiSnapshot {
    return this.snapshot(this.read(botId));
  }

  async local(botId: string, input: PiiLocalRequest): Promise<PiiSnapshot> {
    if (input.action === "list") return this.list(botId);
    const code = compilePiiSource(input.source);
    await this.runner.evaluate([{ id: "new-plugin", code }], "");
    const current = this.read(botId, false);
    const pipeline = { ...current, plugins: [...current.plugins] };
    if (pipeline.plugins.length >= PII_MAX_PLUGINS) throw new PiiError("PII_PLUGIN_LIMIT");
    pipeline.plugins.push({ id: randomUUID(), name: input.name, description: input.description, enabled: true, source: input.source });
    pipeline.revision++;
    this.save(botId, pipeline);
    return this.snapshot(pipeline);
  }

  async manage(botId: string, operation: PiiOperation): Promise<PiiResult> {
    try {
      const pipeline = this.read(botId, operation.action === "list");
      if (operation.action === "list") return { status: "complete", snapshot: this.snapshot(pipeline) };
      if (operation.expectedRevision !== pipeline.revision) return { status: "error", code: "PII_CONFLICT", snapshot: this.snapshot(pipeline) };
      if (operation.action === "preview") {
        if (!PiiPreviewTextSchema.safeParse(operation.text).success) throw new PiiError("PII_INVALID_REQUEST");
        const { text: output, triggeredFilters } = await this.filterPipelineWithResult(pipeline, operation.text);
        if (Buffer.byteLength(output, "utf8") > PII_TEXT_MAX_BYTES) throw new PiiError("PII_OUTPUT_TOO_LARGE");
        if (!output.trim()) throw new PiiError("PII_INVALID_RESULT");
        return { status: "complete", snapshot: this.snapshot(pipeline), output, triggeredFilters };
      }
      const index = pipeline.plugins.findIndex((plugin) => plugin.id === operation.pluginId);
      if (index === -1) return operation.action === "remove"
        ? { status: "complete", snapshot: this.snapshot(pipeline) }
        : { status: "error", code: "PII_PLUGIN_NOT_FOUND" };
      const plugins = [...pipeline.plugins];
      if (operation.action === "remove") plugins.splice(index, 1);
      else plugins[index] = { ...plugins[index]!, enabled: operation.enabled };
      const updated = { ...pipeline, revision: pipeline.revision + 1, plugins };
      this.save(botId, updated);
      return { status: "complete", snapshot: this.snapshot(updated) };
    } catch (error) {
      const code = error instanceof PiiError ? PiiErrorCodeSchema.safeParse(error.code) : undefined;
      if (operation.action === "preview" && code?.success) return {
        status: "error", code: code.data, ...(error instanceof PiiError && error.pluginId ? { pluginId: error.pluginId } : {}),
      };
      return { status: "error", code: "PII_UNAVAILABLE" };
    }
  }

  async filter(botId: string, text: string): Promise<string> {
    const pipeline = this.read(botId);
    return this.run(pipeline, text);
  }

  async filterWithResult(botId: string, text: string): Promise<{ text: string; triggeredFilters: { id: string; name: string }[] }> {
    const pipeline = this.read(botId);
    return this.filterPipelineWithResult(pipeline, text);
  }

  private async filterPipelineWithResult(pipeline: Pipeline, text: string) {
    const result = await this.runWithResult(pipeline, text);
    return { text: result.text, triggeredFilters: result.triggers.filter(trigger => trigger.triggered).map(trigger => {
      const plugin = pipeline.plugins.find(plugin => plugin.id === trigger.pluginId)!;
      return { id: plugin.id, name: plugin.name };
    }) };
  }

  private run(pipeline: Pipeline, text: string): Promise<string> {
    return this.runWithResult(pipeline, text).then(result => result.text);
  }

  private runWithResult(pipeline: Pipeline, text: string) {
    let plugins = this.compiled.get(pipeline);
    if (!plugins) {
      plugins = pipeline.plugins.filter((plugin) => plugin.enabled).map((plugin) => {
        try { return { id: plugin.id, code: compilePiiSource(plugin.source) }; }
        catch { throw new PiiError("PII_INVALID_SOURCE", plugin.id); }
      });
      this.compiled.set(pipeline, plugins);
    }
    return this.runner.evaluateWithResult(plugins, text);
  }
}

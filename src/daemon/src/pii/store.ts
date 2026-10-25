import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PiiPluginSchema, PiiPreviewTextSchema, PiiErrorCodeSchema, PII_MAX_PLUGINS, PII_SOURCE_MAX_BYTES, PII_TEXT_MAX_BYTES, type PiiLocalRequest, type PiiOperation, type PiiResult, type PiiSnapshot } from "@alook/shared";
import { PII_DEFAULTS } from "./defaults.js";
import { compilePiiSource, evaluatePii, PiiError } from "./evaluator.js";

const storedPlugin = PiiPluginSchema.extend({ source: z.string().min(1).max(PII_SOURCE_MAX_BYTES) });
const storedPipeline = z.strictObject({ revision: z.number().int().nonnegative(), plugins: z.array(storedPlugin).max(PII_MAX_PLUGINS) });
const storedState = z.strictObject({ version: z.literal(1), bots: z.record(z.string(), storedPipeline) });
type State = z.infer<typeof storedState>;
type Pipeline = z.infer<typeof storedPipeline>;

export class PiiStore {
  private readonly file: string;
  constructor(private readonly directory: string) {
    this.file = join(directory, "pipelines.json");
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.save({ version: 1, bots: {} });
    }
    this.read();
  }

  private read(): State {
    try {
      if (statSync(this.file).size > 16 * 1024 * 1024) throw 0;
      return storedState.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      throw new PiiError("PII_CONFIG_UNAVAILABLE");
    }
  }

  private save(state: State): void {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      chmodSync(this.directory, 0o700);
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
    } catch {
      throw new PiiError("PII_CONFIG_UNAVAILABLE");
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private pipeline(state: State, botId: string, persist = true): Pipeline {
    const current = Object.hasOwn(state.bots, botId) ? state.bots[botId] : undefined;
    if (current) return current;
    const created = { revision: 0, plugins: PII_DEFAULTS.map((plugin) => ({ ...plugin, enabled: true })) };
    Object.defineProperty(state.bots, botId, { value: created, enumerable: true, writable: true, configurable: true });
    if (persist) this.save(state);
    return created;
  }

  private snapshot(pipeline: Pipeline): PiiSnapshot {
    return {
      revision: pipeline.revision,
      plugins: pipeline.plugins.map(({ id, name, description, enabled }) => ({ id, name, description, enabled })),
    };
  }

  list(botId: string): PiiSnapshot {
    return this.snapshot(this.pipeline(this.read(), botId));
  }

  async local(botId: string, input: PiiLocalRequest): Promise<PiiSnapshot> {
    if (input.action === "list") return this.list(botId);
    const code = compilePiiSource(input.source);
    await evaluatePii([{ id: "new-plugin", code }], "");
    const state = this.read();
    const pipeline = this.pipeline(state, botId);
    if (pipeline.plugins.length >= PII_MAX_PLUGINS) throw new PiiError("PII_PLUGIN_LIMIT");
    pipeline.plugins.push({ id: randomUUID(), name: input.name, description: input.description, enabled: true, source: input.source });
    pipeline.revision++;
    this.save(state);
    return this.snapshot(pipeline);
  }

  async manage(botId: string, operation: PiiOperation): Promise<PiiResult> {
    try {
      const state = this.read();
      const pipeline = this.pipeline(state, botId, operation.action !== "preview");
      if (operation.action === "list") return { status: "complete", snapshot: this.snapshot(pipeline) };
      if (operation.expectedRevision !== pipeline.revision) return { status: "error", code: "PII_CONFLICT", snapshot: this.snapshot(pipeline) };
      if (operation.action === "preview") {
        if (!PiiPreviewTextSchema.safeParse(operation.text).success) throw new PiiError("PII_INVALID_REQUEST");
        const output = await this.run(pipeline, operation.text);
        if (Buffer.byteLength(output, "utf8") > PII_TEXT_MAX_BYTES) throw new PiiError("PII_OUTPUT_TOO_LARGE");
        if (!output.trim()) throw new PiiError("PII_INVALID_RESULT");
        return { status: "complete", snapshot: this.snapshot(pipeline), output };
      }
      const index = pipeline.plugins.findIndex((plugin) => plugin.id === operation.pluginId);
      if (index === -1) return operation.action === "remove"
        ? { status: "complete", snapshot: this.snapshot(pipeline) }
        : { status: "error", code: "PII_PLUGIN_NOT_FOUND" };
      if (operation.action === "remove") pipeline.plugins.splice(index, 1);
      else pipeline.plugins[index]!.enabled = operation.enabled;
      pipeline.revision++;
      this.save(state);
      return { status: "complete", snapshot: this.snapshot(pipeline) };
    } catch (error) {
      const code = error instanceof PiiError ? PiiErrorCodeSchema.safeParse(error.code) : undefined;
      if (operation.action === "preview" && code?.success) return {
        status: "error", code: code.data, ...(error instanceof PiiError && error.pluginId ? { pluginId: error.pluginId } : {}),
      };
      return { status: "error", code: "PII_UNAVAILABLE" };
    }
  }

  async filter(botId: string, text: string): Promise<string> {
    const pipeline = this.pipeline(this.read(), botId);
    return this.run(pipeline, text);
  }

  private run(pipeline: Pipeline, text: string): Promise<string> {
    const plugins = pipeline.plugins.filter((plugin) => plugin.enabled).map((plugin) => {
      try { return { id: plugin.id, code: compilePiiSource(plugin.source) }; }
      catch { throw new PiiError("PII_INVALID_SOURCE", plugin.id); }
    });
    return evaluatePii(plugins, text);
  }
}

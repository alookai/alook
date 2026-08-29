import type { RuntimeReasoningCatalog } from "../contract.js";

export const RUNTIME_MODEL_CATALOG_MAX = 512;
const RUNTIME_MODEL_ID_MAX = 100;

export function normalizeRuntimeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > RUNTIME_MODEL_ID_MAX || /\s/.test(id)) return undefined;
  return id;
}

function catalogFromIds(ids: Iterable<string>): RuntimeReasoningCatalog | undefined {
  const seen = new Set<string>();
  const models: RuntimeReasoningCatalog["models"][number][] = [];
  for (const rawId of ids) {
    const id = normalizeRuntimeModelId(rawId);
    if (!id || seen.has(id)) continue;
    if (models.length >= RUNTIME_MODEL_CATALOG_MAX) return undefined;
    seen.add(id);
    models.push({ id, supportedReasoningEfforts: [] });
  }
  if (models.length === 0) return undefined;
  return { updateMode: "unsupported", models };
}

/** Parse OpenCode's `--pure` output: exactly one `provider/model` id per row. */
export function parseOpenCodeModelCatalog(output: string): RuntimeReasoningCatalog | undefined {
  const ids = output.split(/\r?\n/).flatMap((line) => {
    const id = normalizeRuntimeModelId(line);
    return id && /^[^/]+\/.+$/.test(id) ? [id] : [];
  });
  return catalogFromIds(ids);
}

/** Format Pi SDK `ModelRegistry.getAvailable()` entries as canonical provider/id ids. */
export function parsePiModelCatalog(values: unknown): RuntimeReasoningCatalog | undefined {
  if (!Array.isArray(values)) return undefined;
  const ids = values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const model = value as Record<string, unknown>;
    const provider = normalizeRuntimeModelId(model.provider);
    const id = normalizeRuntimeModelId(model.id);
    return provider && id && !provider.includes("/") ? [`${provider}/${id}`] : [];
  });
  return catalogFromIds(ids);
}

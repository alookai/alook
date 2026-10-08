import type { RuntimeReasoningCatalog } from "../../contract.js";
import { normalizeRuntimeModelId, RUNTIME_MODEL_CATALOG_MAX } from "../../internal/modelCatalog.js";
import { asRecord } from "../../internal/utils.js";

export type AntigravityModel = { id: string; displayName?: string };
export type AntigravityCatalog = { models: AntigravityModel[]; currentModelId?: string; configId?: string };

function choices(value: unknown): AntigravityModel[] {
  if (!Array.isArray(value)) return [];
  const rows: AntigravityModel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = asRecord(item);
    if (!row) continue;
    const nested = Array.isArray(row.options) ? row.options : [row];
    for (const child of nested) {
      const option = asRecord(child);
      const id = normalizeRuntimeModelId(option?.value ?? option?.modelId);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = option?.name;
      rows.push({ id, ...(typeof name === "string" && name.length <= 256 ? { displayName: name } : {}) });
      if (rows.length >= RUNTIME_MODEL_CATALOG_MAX) return rows;
    }
  }
  return rows;
}

export function parseAntigravityCatalog(value: unknown): AntigravityCatalog | undefined {
  const session = asRecord(value);
  const config = Array.isArray(session?.configOptions) ? session.configOptions.map(asRecord).find(
    (option) => option?.type === "select" && (option.category === "model" || option.id === "model"),
  ) : undefined;
  const legacy = asRecord(session?.models);
  const models = choices(config ? config.options : legacy?.availableModels);
  if (!models.length) return undefined;
  const current = normalizeRuntimeModelId(config ? config.currentValue : legacy?.currentModelId);
  const configId = normalizeRuntimeModelId(config?.id);
  return {
    models,
    ...(current && models.some((model) => model.id === current) ? { currentModelId: current } : {}),
    ...(configId ? { configId } : {}),
  };
}

function variant(id: string): { family: string; effort: string } | undefined {
  const match = /^(gemini-[a-z0-9.-]+)-(high|medium|low)$/.exec(id);
  return match ? { family: match[1]!, effort: match[2]! } : undefined;
}

export function antigravityReasoningCatalog(catalog: AntigravityCatalog): RuntimeReasoningCatalog {
  return {
    updateMode: "live_next_turn",
    ...(catalog.currentModelId ? { defaultModelId: catalog.currentModelId } : {}),
    models: catalog.models.map((model) => {
      const selected = variant(model.id);
      const efforts = selected ? catalog.models.flatMap((candidate) => {
        const other = variant(candidate.id);
        return other?.family === selected.family ? [{ value: other.effort }] : [];
      }) : [];
      return { ...model, supportedReasoningEfforts: efforts,
        ...(selected ? { defaultReasoningEffort: selected.effort } : {}),
      };
    }),
  };
}

export function antigravityModelForEffort(catalog: AntigravityCatalog, modelId: string, effort?: string): string | undefined {
  if (!catalog.models.some((model) => model.id === modelId)) return undefined;
  if (!effort) return modelId;
  const selected = variant(modelId);
  if (!selected) return undefined;
  return catalog.models.find((candidate) => {
    const other = variant(candidate.id);
    return other?.family === selected.family && other.effort === effort;
  })?.id;
}

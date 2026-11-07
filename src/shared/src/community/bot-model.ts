// Stored model names are not a catalog gate: non-empty names remain launchable.
import type { ModelConfig } from "../runtime-config";

export function requiresExplicitModel(runtime: string | null | undefined): boolean {
  return runtime === "opencode" || runtime === "pi-durable" || runtime === "cursor-sdk";
}

export const MODEL_SELECT_DEFAULT = "__default__";

export const MODEL_SELECT_CUSTOM = "__custom__";

// Blank stored names select the runtime default; all other names remain named.
export function resolveModelConfig(modelName: string | null): ModelConfig {
  const name = (modelName ?? "").trim();
  if (name.length === 0) return { kind: "default" };
  return { kind: "named", name };
}

/**
 * Card label. `null` when the model is default (the card renders no segment).
 *
 * Display rule: the stored value is always the full launchable id; strip
 * exactly ONE leading `` `${runtime}-` `` prefix when present, and nothing
 * else. A name equal to the bare runtime is returned unchanged (never emptied).
 *   ("claude", "claude-opus-4-6") → "opus-4-6"
 *   ("codex", "gpt-5.4")         → "gpt-5.4"
 *   ("claude", "claude")         → "claude"
 *   (*, null)                    → null
 */
export function formatModelLabel(
  runtime: string | null,
  modelName: string | null
): string | null {
  const name = (modelName ?? "").trim();
  if (name.length === 0) return null;
  if (runtime) {
    const prefix = `${runtime}-`;
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

export function modelSelectState(
  modelIds: readonly string[],
  modelName: string | null
): { selectValue: string; customName: string } {
  const name = (modelName ?? "").trim();
  if (name.length === 0) return { selectValue: MODEL_SELECT_DEFAULT, customName: "" };
  const inCatalog = modelIds.includes(name);
  if (inCatalog) return { selectValue: name, customName: "" };
  return { selectValue: MODEL_SELECT_CUSTOM, customName: name };
}

// Base UI can emit null when a Select is cleared; this must mean Default.
export function modelNameFromSelect(
  selectValue: string | null,
  customName: string
): string | null {
  if (selectValue === null || selectValue === MODEL_SELECT_DEFAULT) return null;
  if (selectValue === MODEL_SELECT_CUSTOM) {
    const trimmed = customName.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return selectValue;
}

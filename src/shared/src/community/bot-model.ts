/**
 * The single owner of every model-name ↔ `ModelConfig` ↔ Select translation.
 *
 * Storage (`community_bot_binding.model_name`), the wire request body, and the
 * UI all speak `string | null`. `ModelConfig` (the structured shape the daemon
 * consumes) is constructed in exactly ONE place — `resolveModelConfig` — so the
 * two wake sites, two write routes, and the picker cannot drift on how a stored
 * name maps to `{ kind }`.
 *
 * The `kind` (`default` / `named` / `custom`) is DERIVED from catalog
 * membership at read time, never stored: a value in the runtime's catalog is
 * `named`, anything else is `custom`, `null`/empty is `default`. Deriving at
 * read time always reflects the CURRENT catalog — a model entering our catalog
 * means it's first-party and should shed the custom-model env var — which a
 * persisted kind could not do.
 */

import type { ModelConfig } from "../runtime-config";
import { getRuntimeModelCatalog } from "../constants/runtime-models";

/** Select sentinel for "Default (the runtime's own default)". */
export const MODEL_SELECT_DEFAULT = "__default__";
/** Select sentinel for "Custom…" (reveals a free-text input). */
export const MODEL_SELECT_CUSTOM = "__custom__";

/**
 * The ONLY place a `ModelConfig` is constructed from stored model-name state
 * (outside `makeRuntimeConfig`'s own default). `null`, `""`, and
 * whitespace-only all mean the runtime's default. A catalog-member id resolves
 * to `named`; anything else to `custom`.
 */
export function resolveModelConfig(
  runtime: string | null,
  modelName: string | null
): ModelConfig {
  const name = (modelName ?? "").trim();
  if (name.length === 0) return { kind: "default" };
  const inCatalog = getRuntimeModelCatalog(runtime).models.includes(name);
  return inCatalog ? { kind: "named", name } : { kind: "custom", name };
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

/**
 * Seed the picker: which Select value is active, plus the text to prefill the
 * custom input with. A stored default → the Default sentinel and empty text; a
 * catalog id → that id as the Select value; anything else → the Custom sentinel
 * with the stored name in the text field.
 */
export function modelSelectState(
  runtime: string | null,
  modelName: string | null
): { selectValue: string; customName: string } {
  const name = (modelName ?? "").trim();
  if (name.length === 0) return { selectValue: MODEL_SELECT_DEFAULT, customName: "" };
  const inCatalog = getRuntimeModelCatalog(runtime).models.includes(name);
  if (inCatalog) return { selectValue: name, customName: "" };
  return { selectValue: MODEL_SELECT_CUSTOM, customName: name };
}

/**
 * Read the picker back out into a stored model-name. The Default sentinel and a
 * cleared Select (Base UI can emit `null`) both map to `null` ⇒ default. The
 * Custom sentinel maps to the trimmed custom text (empty ⇒ `null`). Any other
 * value is a catalog id, returned verbatim.
 */
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

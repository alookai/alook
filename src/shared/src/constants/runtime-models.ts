/**
 * Runtime model catalog — a static, runtime-keyed suggestion list for the
 * per-bot model picker. This is the community-bot analogue of the legacy,
 * provider-keyed `RUNTIME_MODEL_OPTIONS` env var (wired only to `/w` agent
 * forms); it is keyed by RUNTIME id instead, seeded from what each daemon
 * driver actually does at launch today.
 *
 * The catalog SUGGESTS; it does not GATE. `named` vs `custom` is derived from
 * membership at read time (see `resolveModelConfig` in
 * `community/bot-model.ts`) — a value in `models` resolves to `named`,
 * anything else to `custom`. This preserves the distinction the daemon's
 * `resolveLaunchFields` needs (a `custom` model on `claude` additionally sets
 * `ANTHROPIC_CUSTOM_MODEL_OPTION`) without hard-rejecting a model the vendor
 * shipped after our last deploy — and, unlike a persisted kind, it stays
 * correct when the catalog grows.
 */

export interface RuntimeModelCatalogEntry {
  /** Known-good ids for the picker. Empty ⇒ Default + free text only. */
  readonly models: readonly string[];
}

/**
 * Seeded from what each driver does today. `claude`/`codex` mirror the ids
 * already in `RUNTIME_MODEL_OPTIONS`; runtimes with no curated list get
 * `{ models: [] }` (Default + free text).
 */
export const RUNTIME_MODEL_CATALOG: Record<string, RuntimeModelCatalogEntry> = {
  claude: {
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  codex: {
    models: ["gpt-5.4", "gpt-5.3-codex"],
  },
  cursor: { models: [] },
  opencode: { models: [] },
  pi: { models: [] },
};

/** Fallback for unknown/`null` runtime ids — a usable free-text field. */
const FALLBACK_ENTRY: RuntimeModelCatalogEntry = { models: [] };

/**
 * Catalog entry for a runtime id. Unknown or `null` runtimes fall back to
 * `{ models: [] }` so a runtime added to the daemon before the catalog still
 * gets a usable free-text field.
 */
export function getRuntimeModelCatalog(runtime: string | null): RuntimeModelCatalogEntry {
  if (runtime === null) return FALLBACK_ENTRY;
  return RUNTIME_MODEL_CATALOG[runtime] ?? FALLBACK_ENTRY;
}

import type {
  BuiltinBackendId,
  BuiltinBackendSpecs,
  ConfigOf,
  ModelSelection,
  ReasoningEffort,
} from "./contract.js";

export interface BuiltinRuntimeConfigInput {
  readonly runtime: string;
  readonly model: ModelSelection;
  readonly mode: { readonly kind: "default" | "fast" };
  readonly reasoningEffort?: ReasoningEffort;
  readonly provider?:
    | { readonly kind: "default" }
    | { readonly kind: "custom"; readonly apiUrl: string; readonly apiKey: string }
    | { readonly kind: "pi-builtin"; readonly providerId: string; readonly apiKey: string };
  readonly command?: string;
  readonly disallowedTools?: string;
  readonly envVars?: Readonly<Record<string, string>>;
}

export type BuiltinBackendSelection = {
  [Id in BuiltinBackendId]: {
    readonly backend: Id;
    readonly config: ConfigOf<BuiltinBackendSpecs, Id>;
  };
}[BuiltinBackendId];

export function toBuiltinBackendSelection(config: BuiltinRuntimeConfigInput): BuiltinBackendSelection {
  const base = { model: config.model, command: config.command, environment: config.envVars };
  switch (config.runtime) {
    case "claude":
      return {
        backend: "claude",
        config: {
          ...base,
          provider: config.provider?.kind === "custom"
            ? { kind: "custom_endpoint", apiUrl: config.provider.apiUrl, apiKey: config.provider.apiKey }
            : { kind: "default" },
          reasoningEffort: config.reasoningEffort,
          mode: config.mode.kind,
          disallowedTools: config.disallowedTools,
        },
      };
    case "codex":
      return {
        backend: "codex",
        config: { ...base, reasoningEffort: config.reasoningEffort, mode: config.mode.kind },
      };
    case "cursor":
      return { backend: "cursor", config: base };
    case "opencode":
      return { backend: "opencode", config: base };
    case "pi":
      return {
        backend: "pi",
        config: {
          model: config.model,
          environment: config.envVars,
          provider: config.provider?.kind === "pi-builtin"
            ? { kind: "builtin", providerId: config.provider.providerId, apiKey: config.provider.apiKey }
            : { kind: "default" },
          reasoningEffort: config.reasoningEffort,
        },
      };
    default:
      throw new Error(`Unknown runtime: ${config.runtime}`);
  }
}

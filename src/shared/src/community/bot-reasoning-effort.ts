import type {
  ReasoningEffort,
  ReasoningEffortOption,
  RuntimeReasoningCatalog,
} from "../runtime-config";

export type RuntimeReasoningDescriptor = {
  reasoning?: RuntimeReasoningCatalog;
};

export type ReasoningEffortResolution = {
  modelId: string | null;
  options: readonly ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort | null;
  canonicalEffort: ReasoningEffort | null;
  supported: boolean;
};

export function resolveReasoningEffort(
  runtime: RuntimeReasoningDescriptor | null | undefined,
  modelName: string | null,
  requested: ReasoningEffort | null,
): ReasoningEffortResolution {
  const catalog = runtime?.reasoning;
  const modelId = modelName ?? catalog?.defaultModelId ?? null;
  const model = modelId
    ? catalog?.models.find((candidate) => candidate.id === modelId)
    : undefined;
  const options = model?.supportedReasoningEfforts ?? [];
  const supported = requested === null || options.some((option) => option.value === requested);
  return {
    modelId,
    options,
    defaultReasoningEffort: model?.defaultReasoningEffort ?? null,
    canonicalEffort: supported ? requested : null,
    supported,
  };
}

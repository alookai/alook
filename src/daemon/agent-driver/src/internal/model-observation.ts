import type { ModelObservation } from "../contract.js";
import type { AdapterEvent } from "./adapter.js";

function id(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= 256 && !/\s|[\u0000-\u001f\u007f]/.test(result) ? result : undefined;
}

export function modelObservation(
  model: unknown,
  source: ModelObservation["source"],
  provider?: unknown,
  responseId?: unknown,
): Extract<AdapterEvent, { kind: "model_observed" }> | undefined {
  if (!["response", "session", "aggregate"].includes(source)) return undefined;
  const reported = id(model);
  if (!reported) return undefined;
  const providerId = id(provider);
  const response = id(responseId);
  return { kind: "model_observed", observation: {
    model: reported, source,
    ...(providerId ? { provider: providerId } : {}),
    ...(response ? { responseId: response } : {}),
  } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function acpModelObservation(value: unknown): ReturnType<typeof modelObservation> {
  const frame = record(value);
  if (!frame) return undefined;
  const option = Array.isArray(frame.configOptions)
    ? frame.configOptions.map(record).find((item) => item?.id === "model") : undefined;
  return modelObservation(
    option?.currentValue ?? record(frame.models)?.currentModelId ?? record(frame._meta)?.model
      ?? (frame.sessionUpdate === "current_model_update" ? frame.modelId ?? frame.model_id : undefined),
    "session",
  );
}

export function messageModelObservation(value: unknown): ReturnType<typeof modelObservation> {
  const message = record(value);
  if (!message) return undefined;
  const model = record(message.model);
  return modelObservation(
    model?.id ?? model?.modelID ?? message.modelID ?? message.model,
    "response", model?.providerID ?? model?.provider ?? message.providerID ?? message.provider,
    message.responseId ?? message.id,
  );
}

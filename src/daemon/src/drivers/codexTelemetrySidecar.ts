/**
 * Codex telemetry sidecar — maps Codex's two telemetry notifications into
 * `telemetry` ParsedEvents. Kept separate from the main event flow because it
 * is purely observability (token accounting + rate limits), not turn content.
 */
import type { ParsedEvent } from "../types.js";

export function mapCodexTelemetry(method: string, params: any): ParsedEvent[] {
  if (method === "thread/tokenUsage/updated") {
    const u = params?.usage ?? params ?? {};
    return [
      {
        kind: "telemetry",
        name: "token_usage",
        source: "codex_thread_token_usage_updated",
        usageKind: "cumulative_session",
        attrs: {
          totalTokens: u.totalTokens ?? u.total_tokens,
          inputTokens: u.inputTokens ?? u.input_tokens,
          cachedInputTokens: u.cachedInputTokens ?? u.cached_input_tokens,
          outputTokens: u.outputTokens ?? u.output_tokens,
          reasoningOutputTokens: u.reasoningOutputTokens ?? u.reasoning_output_tokens,
          modelContextWindow: u.modelContextWindow ?? u.model_context_window,
          cachedInputRatio: u.cachedInputRatio,
          contextUtilization: u.contextUtilization,
        },
      },
    ];
  }
  if (method === "account/rateLimits/updated") {
    const r = params ?? {};
    return [
      {
        kind: "telemetry",
        name: "rate_limits",
        source: "codex_account_rate_limits_updated",
        attrs: {
          limitId: r.limitId,
          planType: r.planType,
          usedPercent: r.usedPercent,
          windowDurationMins: r.windowDurationMins,
          resetsAt: r.resetsAt,
        },
      },
    ];
  }
  return [];
}

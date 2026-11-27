import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProviderQuotaObservation, QuotaLimit } from "../../contract.js";
import {
  DiscoveryProcessError,
  runBoundedDiscoveryProcess,
  type DiscoveryProcessDependencies,
} from "../../internal/discovery-process.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { quotaDate, quotaLabel, quotaObservation, quotaSource, type QuotaReadOptions } from "../../internal/quota-reader.js";
import { asRecord } from "../../internal/utils.js";
import { agySpawnSpec, parseAgyModelCatalog } from "./probe.js";

function classifyAgyQuotaError(
  message: string,
  sourceEpoch: string,
  structured: boolean,
): ProviderQuotaObservation | null {
  const text = message.trim();
  if (!text) return null;
  if (/(?:not authenticated|authentication (?:required|failed)|sign[ -]?in required|unauthenticated|unauthorized|invalid credentials|token expired|permission denied|\b401\b|\b403\b)/i.test(text)) {
    return { status: "error", sourceEpoch, code: "unauthorized", retryable: false };
  }
  if (/(?:eligibility check failed|not eligible|not (?:currently )?available in your (?:location|region|country)|unsupported (?:location|region|country))/i.test(text)) {
    return { status: "error", sourceEpoch, code: "provider_error", retryable: false };
  }
  if (/(?:econnrefused|econnreset|etimedout|enotfound|ehostunreach|network error|fetch failed|dial tcp|socket hang up|connection refused|connection reset|proxyconnect|timed out|\bdns\b|\btls\b|\bssl\b)/i.test(text)) {
    return { status: "error", sourceEpoch, code: "network", retryable: true };
  }
  if (/(?:rate[ -]?limit|too many requests|quota exceeded|\b429\b|\b50[0234]\b|internal server error|service unavailable|bad gateway|temporarily unavailable|resource exhausted|upstream)/i.test(text)) {
    return { status: "error", sourceEpoch, code: "provider_error", retryable: true };
  }
  return structured
    ? { status: "error", sourceEpoch, code: "provider_error", retryable: true }
    : null;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function parseAgyQuota(value: unknown, sourceEpoch: string): ProviderQuotaObservation {
  const result = asRecord(value);
  if (result?.status === "ERROR" && typeof result.error === "string" && result.error.trim()) {
    return classifyAgyQuotaError(result.error, sourceEpoch, true)
      ?? { status: "error", sourceEpoch, code: "provider_error", retryable: true };
  }
  const command = asRecord(result?.command);
  const data = asRecord(command?.data);
  const groups = data?.groups;
  const usage = asRecord(result?.usage);
  const invalid = (): ProviderQuotaObservation => ({ status: "error", sourceEpoch, code: "invalid_response", retryable: true });
  if (result?.status !== "SUCCESS" || command?.name !== "usage" || result.num_turns !== 0 || result.conversation_id || !usage || Object.values(usage).some((value) => value !== 0) || !Array.isArray(groups)) return invalid();
  const limits: QuotaLimit[] = [];
  for (const group of groups) {
    const buckets = asRecord(group)?.buckets;
    if (buckets === undefined) continue;
    if (!Array.isArray(buckets)) return invalid();
    for (const item of buckets) {
      const row = asRecord(item);
      const id = quotaLabel(row?.id);
      const name = quotaLabel(row?.name);
      const window = quotaLabel(row?.window);
      const fraction = row?.remaining_fraction;
      const resetsAt = quotaDate(row?.reset_time);
      if (!id || !name || !window || typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1 || (row?.reset_time && !resetsAt)) return invalid();
      limits.push({ bucket: { limitId: id, product: { kind: "reported", id: "antigravity", displayName: "Antigravity" }, model: { kind: "unknown" }, window: { kind: "provider_defined", id: window, displayName: name } }, usedPercent: (1 - fraction) * 100, ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  if (limits.length > 8 || new Set(limits.map((limit) => `${limit.bucket.limitId}:${limit.bucket.window.kind === "provider_defined" ? limit.bucket.window.id : ""}`)).size !== limits.length) return invalid();
  return quotaObservation(sourceEpoch, undefined, limits);
}

export async function readAgyQuota(options: QuotaReadOptions & DiscoveryProcessDependencies = {}): Promise<ProviderQuotaObservation | null> {
  const env = options.env ?? process.env;
  const spec = agySpawnSpec(options.command, { homeDir: options.home ?? homedir() }, options.platform);
  const source = quotaSource("agy", randomUUID());
  const read = async (args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
    const child = (options.spawn ?? spawnAgentProcess)(spec.command, args, { cwd: options.cwd ?? process.cwd(), env: { ...env, CI: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, shell: spec.shell, stdin: "ignore" });
    let stdout = "";
    let stderr = "";
    return runBoundedDiscoveryProcess({
      process: child,
      label: "AGY quota",
      timeoutMs: options.timeoutMs ?? 30_000,
      outputMaxBytes: options.outputMaxBytes ?? 1024 * 1024,
      stderr: "count",
      cleanupGraceMs: 100,
      cleanup: options.cleanup,
      exitEvent: "close",
      onStdout: (text) => { stdout += text; },
      onStderr: (text) => { stderr += text; },
      onExit: (code, _signal, control) => {
        control.flushStdout();
        control.flushStderr();
        control.finish({ exitCode: code, stdout, stderr });
      },
    });
  };
  try {
    const models = await read(["models"]);
    if (models.exitCode !== 0) {
      const classified = classifyAgyQuotaError(models.stderr || models.stdout, source.epoch, false);
      return source.finish(classified ?? source.error("unavailable", true));
    }
    if (!parseAgyModelCatalog(models.stdout)) return source.finish(source.error("unauthorized"));

    const usage = await read(["-p", "/usage", "--output-format", "json"]);
    const parsed = tryParseJson(usage.stdout);
    if (parsed.ok) {
      const record = asRecord(parsed.value);
      if (usage.exitCode === 0) {
        return source.finish(parseAgyQuota(parsed.value, source.epoch));
      }
      if (record?.status === "ERROR" && typeof record.error === "string" && record.error.trim()) {
        return source.finish(parseAgyQuota(parsed.value, source.epoch));
      }
    }
    if (usage.exitCode === 0) {
      return source.finish(source.error("invalid_response", true));
    }
    const classified = classifyAgyQuotaError(usage.stderr || usage.stdout, source.epoch, false);
    return source.finish(classified ?? source.error("unavailable", true));
  } catch (error) {
    if (error instanceof DiscoveryProcessError && error.code === "output_limit") {
      return source.finish(source.error("invalid_response", true));
    }
    return source.finish(source.error("unavailable", true));
  }
}

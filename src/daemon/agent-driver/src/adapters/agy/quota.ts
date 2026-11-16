import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProviderQuotaObservation, QuotaLimit } from "../../contract.js";
import { runBoundedDiscoveryProcess, type DiscoveryProcessDependencies } from "../../internal/discovery-process.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { quotaDate, quotaLabel, quotaObservation, quotaSource, type QuotaReadOptions } from "../../internal/quota-reader.js";
import { asRecord } from "../../internal/utils.js";
import { agySpawnSpec, parseAgyModelCatalog } from "./probe.js";

export function parseAgyQuota(value: unknown, sourceEpoch: string): ProviderQuotaObservation {
  const result = asRecord(value);
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
  const read = async (args: string[]): Promise<string> => {
    const child = (options.spawn ?? spawnAgentProcess)(spec.command, args, { cwd: options.cwd ?? process.cwd(), env: { ...env, CI: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, shell: spec.shell, stdin: "ignore" });
    let output = "";
    return runBoundedDiscoveryProcess({ process: child, label: "AGY quota", timeoutMs: options.timeoutMs ?? 30_000, outputMaxBytes: options.outputMaxBytes ?? 1024 * 1024, stderr: "count", cleanupGraceMs: 100, cleanup: options.cleanup, exitEvent: "close", onStdout: (text) => { output += text; }, onExit: (code, _signal, control) => { if (code !== 0) return control.fail("AGY quota failed"); control.flushStdout(); control.finish(output); } });
  };
  try {
    if (!parseAgyModelCatalog(await read(["models"]))) return source.finish(source.error("unauthorized"));
    return source.finish(parseAgyQuota(JSON.parse(await read(["-p", "/usage", "--output-format", "json"])), source.epoch));
  } catch { return source.finish(source.error("unavailable", true)); }
}

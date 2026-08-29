import type { AdapterEvent } from "./adapter.js";

interface SettledUsageIdentity {
  readonly runtime: string;
  readonly backendSessionId: string;
  readonly providerRecordId: string;
}

interface SettledUsageRecord extends SettledUsageIdentity {
  readonly source: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly reasoning?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly inputIncludesCache: boolean;
  readonly outputIncludesReasoning: boolean;
}

function validIdentityPart(value: string): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 512;
}

function identityKey(identity: SettledUsageIdentity): string | null {
  if (
    !validIdentityPart(identity.runtime)
    || !validIdentityPart(identity.backendSessionId)
    || !validIdentityPart(identity.providerRecordId)
  ) return null;
  return JSON.stringify([identity.runtime, identity.backendSessionId, identity.providerRecordId]);
}

function metric(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cacheMetric(read: unknown, write: unknown): number | null {
  const present = [read, write].filter((value) => value !== undefined);
  if (present.length === 0) return null;
  const metrics = present.map(metric);
  if (metrics.some((value) => value === null)) return null;
  const total = (metrics as number[]).reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

export class SettledUsageProjector {
  private readonly active = new Set<string>();

  project(record: SettledUsageRecord): AdapterEvent | null {
    const key = identityKey(record);
    if (!key || this.active.has(key)) return null;
    this.active.add(key);

    const cache = cacheMetric(record.cacheRead, record.cacheWrite);
    const rawInput = metric(record.input);
    const input = record.inputIncludesCache
      ? rawInput !== null && cache !== null && cache <= rawInput
        ? rawInput - cache
        : null
      : rawInput;
    const rawOutput = metric(record.output);
    const reasoning = metric(record.reasoning);
    const output = record.outputIncludesReasoning
      ? rawOutput
      : rawOutput !== null && reasoning !== null && Number.isSafeInteger(rawOutput + reasoning)
        ? rawOutput + reasoning
        : null;
    if (input === null && output === null && cache === null) {
      this.active.delete(key);
      return null;
    }
    return {
      kind: "telemetry",
      name: "token_usage",
      source: record.source,
      usage: { input, output, cache },
    };
  }

  release(identity: SettledUsageIdentity): void {
    const key = identityKey(identity);
    if (key) this.active.delete(key);
  }

  reset(): void {
    this.active.clear();
  }

  get activeCount(): number {
    return this.active.size;
  }
}

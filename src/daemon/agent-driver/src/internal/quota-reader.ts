import { createHash, randomBytes } from "node:crypto";
import type { ProviderQuotaObservation, QuotaLimit } from "../contract.js";

export type QuotaReadOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readCredentialsFile?: (path: string) => Promise<string>;
  readKeychain?: (service?: string, account?: string) => Promise<string>;
  fetchUsage?: typeof fetch;
  command?: string;
};

const sources = new Map<string, { identity: string; epoch: string }>();

export function quotaSource(provider: string, identity: string) {
  const hash = createHash("sha256").update(identity).digest("hex");
  let source = sources.get(provider);
  if (source?.identity !== hash) {
    source = { identity: hash, epoch: randomBytes(16).toString("base64url") };
    sources.set(provider, source);
  }
  const current = source;
  return {
    epoch: current.epoch,
    finish: (observation: ProviderQuotaObservation): ProviderQuotaObservation | null => sources.get(provider) === current ? observation : null,
    error: (code: Extract<ProviderQuotaObservation, { status: "error" }>["code"], retryable = false): ProviderQuotaObservation => ({ status: "error", sourceEpoch: current.epoch, code, retryable }),
  };
}

export function quotaLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && !/[\u0000-\u001f\u007f]/.test(text) && Buffer.byteLength(text) <= 64 ? text : undefined;
}

export function quotaPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

export function quotaDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && value <= 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function quotaObservation(sourceEpoch: string, planName: string | undefined, limits: QuotaLimit[]): ProviderQuotaObservation {
  return limits.length || planName
    ? { status: "available", sourceEpoch, ...(planName ? { planName } : {}), freshForSeconds: 300, limits }
    : { status: "error", sourceEpoch, code: "invalid_response", retryable: true };
}

export class QuotaReadError extends Error {
  constructor(readonly code: "unauthorized" | "provider_error" | "invalid_response" | "network", readonly retryable: boolean) { super(code); }
}

export async function quotaJson(url: string, init: RequestInit, fetchUsage = fetch): Promise<unknown> {
  let response: Response;
  try { response = await fetchUsage(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) }); }
  catch { throw new QuotaReadError("network", true); }
  if (!response.ok) throw new QuotaReadError(response.status === 401 || response.status === 403 ? "unauthorized" : "provider_error", response.status === 429 || response.status >= 500);
  try {
    const length = response.headers.get("content-length");
    if (length && Number(length) > 1024 * 1024) throw new Error();
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) throw new Error();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch { throw new QuotaReadError("invalid_response", true); }
}

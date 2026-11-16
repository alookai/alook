import { readAntigravityQuota } from "./adapters/antigravity/quota.js";
import { readCursorQuota } from "./adapters/cursor/quota.js";
import { readAgyQuota } from "./adapters/agy/quota.js";
import { readSdkQuota } from "./internal/sdk-quota-reader.js";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import type { BuiltinBackendId, ProviderQuotaObservation, QuotaLimit } from "./contract.js";

const execFileAsync = promisify(execFile);
let claudeAccessToken: string | null = null;
let claudeSourceEpoch = randomBytes(16).toString("base64url");

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: unknown;
    subscriptionType?: unknown;
  };
};

export type QuotaReaderOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readCredentialsFile?: (path: string) => Promise<string>;
  readKeychain?: () => Promise<string>;
  fetchUsage?: typeof fetch;
  command?: string;
};

function parseCredentials(value: string): ClaudeCredentials | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as ClaudeCredentials : null;
  } catch {
    return null;
  }
}

async function claudeCredentials(options: QuotaReaderOptions): Promise<ClaudeCredentials | null> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    try {
      const value = options.readKeychain
        ? await options.readKeychain()
        : (await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
            timeout: 3_000,
            maxBuffer: 256 * 1024,
          })).stdout;
      const parsed = parseCredentials(value.trim());
      if (parsed) return parsed;
    } catch { }
  }
  const env = options.env ?? process.env;
  const root = env.CLAUDE_CONFIG_DIR || join(options.home ?? homedir(), ".claude");
  try {
    const value = options.readCredentialsFile
      ? await options.readCredentialsFile(join(root, ".credentials.json"))
      : await readFile(join(root, ".credentials.json"), "utf8");
    return parseCredentials(value);
  } catch {
    return null;
  }
}

function mappedPlanName(value: unknown): string | undefined {
  switch (value) {
    case "free": return "Free";
    case "pro": return "Pro";
    case "max": return "Max";
    case "team": return "Team";
    case "enterprise": return "Enterprise";
    default: return undefined;
  }
}

function resetIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function claudeLimit(key: string, value: unknown): QuotaLimit | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.utilization !== "number" || !Number.isFinite(row.utilization) || row.utilization < 0 || row.utilization > 100) return null;
  const model = key.includes("sonnet")
    ? { kind: "reported" as const, id: "claude-sonnet" }
    : key.includes("opus")
      ? { kind: "reported" as const, id: "claude-opus" }
      : { kind: "not_applicable" as const };
  const window = key === "five_hour"
    ? { kind: "rolling" as const, durationSeconds: 18_000, displayName: "5 hour usage limit" }
    : { kind: "rolling" as const, durationSeconds: 604_800, displayName: "7 day usage limit" };
  const resetsAt = resetIso(row.resets_at ?? row.resetsAt);
  return {
    bucket: {
      limitId: key,
      product: { kind: "reported", id: "claude", displayName: "Claude" },
      model,
      window,
    },
    usedPercent: row.utilization,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

async function readClaudeQuota(options: QuotaReaderOptions): Promise<ProviderQuotaObservation | null> {
  const env = options.env ?? process.env;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL) return null;
  const credentials = await claudeCredentials(options);
  const token = credentials?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token.length === 0) return null;
  if (claudeAccessToken !== token) {
    claudeAccessToken = token;
    claudeSourceEpoch = randomBytes(16).toString("base64url");
  }
  let response: Response;
  try {
    response = await (options.fetchUsage ?? fetch)("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { status: "error", sourceEpoch: claudeSourceEpoch, code: "network", retryable: true };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: "error", sourceEpoch: claudeSourceEpoch, code: "unauthorized", retryable: false };
  }
  if (!response.ok) {
    return { status: "error", sourceEpoch: claudeSourceEpoch, code: "provider_error", retryable: response.status === 429 || response.status >= 500 };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", sourceEpoch: claudeSourceEpoch, code: "invalid_response", retryable: true };
  }
  if (!body || typeof body !== "object") {
    return { status: "error", sourceEpoch: claudeSourceEpoch, code: "invalid_response", retryable: true };
  }
  const record = body as Record<string, unknown>;
  const limits = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"]
    .map((key) => claudeLimit(key, record[key]))
    .filter((limit): limit is QuotaLimit => limit !== null);
  if (limits.length === 0) {
    return { status: "error", sourceEpoch: claudeSourceEpoch, code: "invalid_response", retryable: true };
  }
  const planName = mappedPlanName(credentials?.claudeAiOauth?.subscriptionType);
  return {
    status: "available",
    sourceEpoch: claudeSourceEpoch,
    ...(planName ? { planName } : {}),
    freshForSeconds: 300,
    limits,
  };
}

export function supportsBuiltinQuotaPolling(backend: string | undefined): backend is "claude" | "antigravity" | "cursor" | "cursor-sdk" | "copilot" | "qoder" | "agy" {
  return backend === "claude" || backend === "antigravity" || backend === "cursor" || backend === "cursor-sdk" || backend === "copilot" || backend === "qoder" || backend === "agy";
}

async function readProviderQuota(
  backend: BuiltinBackendId,
  options: QuotaReaderOptions = {},
): Promise<ProviderQuotaObservation | null> {
  if (backend === "claude") return readClaudeQuota(options);
  if (backend === "antigravity") return readAntigravityQuota(options);
  if (backend === "cursor" || backend === "cursor-sdk") return readCursorQuota(options, backend);
  if (backend === "copilot" || backend === "qoder") return readSdkQuota(backend, options);
  if (backend === "agy") return readAgyQuota(options);
  return null;
}

const quotaReads = new Map<BuiltinBackendId, { read: Promise<ProviderQuotaObservation | null>; expiresAt: number; readAt: number }>();

export async function readBuiltinProviderQuota(backend: BuiltinBackendId, options?: QuotaReaderOptions): Promise<ProviderQuotaObservation | null> {
  if (options) return readProviderQuota(backend, options);
  const previous = quotaReads.get(backend);
  if (previous && previous.expiresAt > Date.now()) {
    const observation = await previous.read;
    return observation?.status === "available" ? { ...observation, freshForSeconds: Math.max(1, observation.freshForSeconds - Math.floor((Date.now() - previous.readAt) / 1_000)) } : observation;
  }
  const current = { read: Promise.resolve(null) as Promise<ProviderQuotaObservation | null>, expiresAt: Number.POSITIVE_INFINITY, readAt: 0 };
  current.read = readProviderQuota(backend).finally(() => { current.readAt = Date.now(); current.expiresAt = current.readAt + 30_000; });
  quotaReads.set(backend, current);
  return current.read;
}

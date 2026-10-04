import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProviderQuotaObservation, QuotaLimit } from "../../contract.js";
import { asRecord } from "../../internal/utils.js";

import { readLocalCommand } from "./local-data.js";
const PROD = "https://cloudcode-pa.googleapis.com";
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
type Source = { identity: string; epoch: string; accessToken?: { value: string; expiresAt: number } };
let activeSource: Source = { identity: "", epoch: randomBytes(16).toString("base64url") };

type AntigravityQuotaReaderOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readCredentialsFile?: (path: string) => Promise<string>;
  readKeychain?: () => Promise<string>;
  fetchUsage?: typeof fetch;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function label(value: unknown): string | undefined {
  const result = text(value);
  return result && Buffer.byteLength(result) <= 64 ? result : undefined;
}

export function parseAntigravityQuota(value: unknown): QuotaLimit[] | undefined {
  const body = asRecord(value);
  if (!body) return undefined;
  const groups = body.groups;
  const buckets: { value: unknown; group?: string }[] = [];
  if (groups !== undefined) {
    if (!Array.isArray(groups) || groups.length > 64) return undefined;
    for (const item of groups) {
      const group = asRecord(item);
      if (!group || (group.buckets !== undefined && !Array.isArray(group.buckets))) return undefined;
      for (const value of (group.buckets as unknown[] | undefined) ?? []) buckets.push({ value, group: label(group.displayName) });
    }
  } else {
    if (!Array.isArray(body.buckets)) return undefined;
    for (const value of body.buckets) buckets.push({ value });
  }
  if (buckets.length > 128) return undefined;
  const limits = new Map<string, QuotaLimit>();
  for (const item of buckets) {
    const row = asRecord(item.value);
    if (!row) return undefined;
    if (row.disabled === true) continue;
    const id = label(row.bucketId);
    const fraction = row.remainingFraction;
    const windowId = row.window === undefined || row.window === "" ? "unspecified" : label(row.window);
    if (!id || !windowId || typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return undefined;
    const windowName = label(row.displayName) ?? item.group ?? id;
    const resetsAt = text(row.resetTime);
    if (resetsAt && !Number.isFinite(Date.parse(resetsAt))) return undefined;
    const limit: QuotaLimit = {
      bucket: {
        limitId: id,
        product: { kind: "reported", id: "antigravity", displayName: "Antigravity" },
        model: { kind: "unknown" },
        window: { kind: "provider_defined", id: windowId, displayName: windowName },
      },
      usedPercent: (1 - fraction) * 100,
      ...(resetsAt ? { resetsAt: new Date(resetsAt).toISOString() } : {}),
    };
    const key = `${id}\0${windowId}`;
    const previous = limits.get(key);
    if (previous && (previous.usedPercent !== limit.usedPercent || previous.resetsAt !== limit.resetsAt)) return undefined;
    limits.set(key, previous ?? limit);
  }
  return limits.size <= 8 ? [...limits.values()] : undefined;
}

export async function readAntigravityQuota(options: AntigravityQuotaReaderOptions = {}): Promise<ProviderQuotaObservation> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configuredHome = env.GEMINI_HOME?.replace(/^~(?=[/\\]|$)/, home);
  const root = configuredHome ? (isAbsolute(configuredHome) ? configuredHome : join(process.cwd(), configuredHome)) : join(home, ".gemini");
  const read = options.readCredentialsFile ?? ((path: string) => readFile(path, "utf8"));
  let credentials: Record<string, unknown> | null = null;
  let authType: unknown;
  try {
    authType = asRecord(asRecord(JSON.parse(await read(join(root, "antigravity-acp", "settings.json"))))?.auth)?.type;
    if (authType === "oauth-personal") {
      if ((options.platform ?? process.platform) === "darwin" && !/^(1|true|yes)$/i.test(env.AGY_ACP_FORCE_FILE_STORAGE ?? "")) {
        try {
          const value = options.readKeychain ? await options.readKeychain() : await readLocalCommand("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity-acp", "-w"]);
          credentials = asRecord(JSON.parse(value));
        } catch { }
      }
      if (!credentials) {
        try { credentials = asRecord(JSON.parse(await read(join(root, "antigravity-acp", "acp_token.json")))); } catch { }
      }
    }
  } catch { }
  const identity = createHash("sha256").update(JSON.stringify([root, authType, credentials?.client_id, credentials?.refresh_token, credentials?.project_id])).digest("hex");
  if (activeSource.identity !== identity) activeSource = { identity, epoch: randomBytes(16).toString("base64url") };
  const source = activeSource;
  const error = (code: Extract<ProviderQuotaObservation, { status: "error" }>["code"], retryable = false): ProviderQuotaObservation => ({ status: "error", sourceEpoch: activeSource.epoch, code: source === activeSource ? code : "unavailable", retryable: source === activeSource ? retryable : true });
  const clientId = text(credentials?.client_id);
  const clientSecret = text(credentials?.client_secret);
  const refreshToken = text(credentials?.refresh_token);
  if (authType !== "oauth-personal") return error("unavailable");
  if (!clientId || !clientSecret || !refreshToken) return error("unauthorized");
  const fetchUsage = options.fetchUsage ?? fetch;
  const post = async (url: string, body: unknown, token: string) => {
    const response = await fetchUsage(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "alook-agent-driver/1 antigravity" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw { quotaCode: response.status === 401 || response.status === 403 ? "unauthorized" : "provider_error", retryable: response.status === 429 || response.status >= 500 };
    try { return asRecord(await response.json()); } catch { throw { quotaCode: "invalid_response", retryable: true }; }
  };
  try {
    if (!source.accessToken || source.accessToken.expiresAt <= Date.now()) {
      const response = await fetchUsage("https://oauth2.googleapis.com/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
      });
      if (!response.ok) return error(response.status === 400 || response.status === 401 || response.status === 403 ? "unauthorized" : "provider_error", response.status === 429 || response.status >= 500);
      let body: Record<string, unknown> | null;
      try { body = asRecord(await response.json()); } catch { return error("invalid_response", true); }
      const token = text(body?.access_token);
      const expires = body?.expires_in;
      if (!token || typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) return error("invalid_response", true);
      source.accessToken = { value: token, expiresAt: Date.now() + Math.min(expires, 3600) * 1000 - 30_000 };
    }
    const bootstrap = env.AGY_ACP_CCPA_BASE_URL || PROD;
    if (bootstrap !== PROD && bootstrap !== DAILY) return error("unavailable");
    const loaded = await post(`${bootstrap}/v1internal:loadCodeAssist`, { metadata: { ideType: "ANTIGRAVITY" } }, source.accessToken.value);
    const project = text(loaded?.cloudaicompanionProject);
    if (!project || !asRecord(loaded?.currentTier)) return error("unauthorized");
    const endpoint = env.AGY_ACP_CCPA_BASE_URL || (asRecord(loaded?.paidTier)?.usesGcpTos === true ? PROD : DAILY);
    const summary = await post(`${endpoint}/v1internal:retrieveUserQuotaSummary`, { project }, source.accessToken.value);
    const limits = parseAntigravityQuota(summary);
    if (!limits) return error("invalid_response", true);
    if (!limits.length) return error("unavailable");
    const planName = label(asRecord(loaded?.paidTier)?.name ?? asRecord(loaded?.currentTier)?.name);
    if (source !== activeSource) return { status: "error", sourceEpoch: activeSource.epoch, code: "unavailable", retryable: true };
    return { status: "available", sourceEpoch: source.epoch, freshForSeconds: 300, ...(planName ? { planName } : {}), limits };
  } catch (failure) {
    const known = asRecord(failure);
    if (known?.quotaCode === "unauthorized" || known?.quotaCode === "provider_error" || known?.quotaCode === "invalid_response") {
      if (known.quotaCode === "unauthorized") source.accessToken = undefined;
      return error(known.quotaCode, known.retryable === true);
    }
    return error("network", true);
  }
}

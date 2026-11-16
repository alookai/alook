import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderQuotaObservation, QuotaLimit } from "../../contract.js";
import { asRecord } from "../../internal/utils.js";
import { quotaDate, quotaJson, quotaLabel, quotaObservation, quotaPercent, QuotaReadError, quotaSource, type QuotaReadOptions } from "../../internal/quota-reader.js";
import { readLocalCommand } from "../antigravity/local-data.js";

export function parseCursorQuota(plan: unknown, period: unknown, sourceEpoch: string): ProviderQuotaObservation {
  const info = asRecord(plan);
  const planInfo = asRecord(info?.planInfo);
  const data = asRecord(period);
  const usage = asRecord(data?.planUsage);
  const planName = quotaLabel(planInfo?.planName);
  const resetValue = data?.billingCycleEnd;
  const resetsAt = quotaDate(typeof resetValue === "string" && /^\d+$/.test(resetValue) ? Number(resetValue) : resetValue);
  const limits: QuotaLimit[] = [];
  const merged = info?.isMerged === true;
  const periodKind = planInfo?.includedUsagePeriod;
  const weekly = periodKind === "INCLUDED_USAGE_PERIOD_WEEKLY" || periodKind === 2;
  const monthly = periodKind === "INCLUDED_USAGE_PERIOD_MONTHLY" || periodKind === 1;
  const rows = merged
    ? [["included", weekly ? "Weekly included usage" : monthly ? "Monthly included usage" : "Included usage", usage?.totalPercentUsed]] as const
    : [["cursor-models", "Cursor Models", usage?.autoPercentUsed], ["other-models", "Other Models", usage?.apiPercentUsed]] as const;
  for (const [id, name, value] of rows) {
    const usedPercent = quotaPercent(value);
    if (usedPercent === undefined) continue;
    limits.push({
      bucket: {
        limitId: id, product: { kind: "reported", id: "cursor", displayName: "Cursor" }, model: { kind: "unknown" },
        window: { kind: "provider_defined", id: merged && weekly ? "weekly-included" : merged && monthly ? "monthly-included" : "billing-period", displayName: name },
      }, usedPercent, ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return quotaObservation(sourceEpoch, planName, limits);
}

export async function readCursorQuota(options: QuotaReadOptions = {}, backend: "cursor" | "cursor-sdk" = "cursor"): Promise<ProviderQuotaObservation | null> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const read = options.readCredentialsFile ?? ((path: string) => readFile(path, "utf8"));
  let token: string | undefined;
  let team: string | undefined;
  let invalid = false;
  let apiKey = env.CURSOR_API_KEY?.trim();
  const apiKeyProvided = env.CURSOR_API_KEY !== undefined;
  const store = env.AGENT_CLI_CREDENTIAL_STORE;
  let unavailable = backend === "cursor" && store === "memory" && !apiKey;
  let retryableUnavailable = false;
  const configRoot = env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "cursor") : join(home, ".cursor"));
  try {
    if (backend === "cursor-sdk") {
      const backendUrl = env.CURSOR_BACKEND_URL ?? "https://api2.cursor.sh";
      if (backendUrl.replace(/\/$/, "") !== "https://api2.cursor.sh") unavailable = true;
      if (!apiKeyProvided && !unavailable) {
        const stored = asRecord(JSON.parse(await read(join(home, ".cursor", "sdk", "auth.json"))));
        if (stored?.version !== 1 || typeof stored.backendUrl !== "string" || typeof stored.apiKey !== "string" || typeof stored.createdAtMs !== "number" || !Number.isFinite(stored.createdAtMs) || (stored.apiKeyExpiresAtMs !== undefined && (typeof stored.apiKeyExpiresAtMs !== "number" || !Number.isFinite(stored.apiKeyExpiresAtMs))) || (stored.email !== undefined && typeof stored.email !== "string")) invalid = true;
        else if (stored.backendUrl !== backendUrl) unavailable = true;
        else if (typeof stored.apiKeyExpiresAtMs === "number" && stored.apiKeyExpiresAtMs <= Date.now()) apiKey = undefined;
        else if (typeof stored.apiKey === "string") apiKey = stored.apiKey.trim();
      }
    } else if (!unavailable && !apiKeyProvided && platform === "darwin" && store !== "file") {
      try { token = (await (options.readKeychain ? options.readKeychain("cursor-access-token", "cursor-user") : readLocalCommand("security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"]))).trim() || undefined; }
      catch { unavailable = true; retryableUnavailable = true; }
    }
    if (backend === "cursor" && !unavailable && !apiKeyProvided && !token && (platform !== "darwin" || store === "file")) {
      const root = platform === "win32" ? join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor")
        : platform === "darwin" ? join(home, ".cursor") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "cursor");
      token = asRecord(JSON.parse(await read(join(root, "auth.json"))))?.accessToken as string | undefined;
    }
    if (typeof token !== "string" || !token.trim()) token = undefined;
    if (backend === "cursor" && !apiKey && token) {
      try {
        const auth = asRecord(asRecord(JSON.parse(await read(join(configRoot, "cli-config.json"))))?.authInfo);
        const subject = asRecord(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")))?.sub;
        const active = auth?.activeTeamId;
        if (typeof active === "string" || typeof active === "number") {
          if (subject && auth?.authId === subject) team = String(active);
          else unavailable = true;
        }
      } catch { }
    }
  } catch (error) { invalid = asRecord(error)?.code !== "ENOENT"; }
  const source = quotaSource(backend, `${configRoot}\0${store ?? "default"}\0${env.CURSOR_BACKEND_URL ?? ""}\0${apiKey ?? token ?? "signed-out"}\0${team ?? ""}`);
  if (unavailable) return source.finish(source.error("unavailable", retryableUnavailable));
  if (!apiKey && !token) return source.finish(source.error(invalid ? "invalid_response" : "unauthorized", invalid));
  try {
    if (apiKey) {
      const exchanged = asRecord(await quotaJson("https://api2.cursor.sh/auth/exchange_user_api_key", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: "{}" }, options.fetchUsage));
      if (typeof exchanged?.accessToken !== "string" || !exchanged.accessToken.trim()) throw new QuotaReadError("invalid_response", true);
      token = exchanged.accessToken;
    }
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1", ...(team ? { "x-cursor-team-id": team } : {}) };
    const ask = (method: string) => quotaJson(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, { method: "POST", headers, body: "{}" }, options.fetchUsage);
    const [plan, usage] = await Promise.allSettled([ask("GetPlanInfo"), ask("GetCurrentPeriodUsage")]);
    for (const result of [plan, usage]) {
      if (result.status === "rejected" && result.reason instanceof QuotaReadError && result.reason.code === "unauthorized") throw result.reason;
    }
    const observation = parseCursorQuota(plan.status === "fulfilled" ? plan.value : undefined, usage.status === "fulfilled" ? usage.value : undefined, source.epoch);
    if (observation.status === "error") {
      if (plan.status === "rejected") throw plan.reason;
      if (usage.status === "rejected") throw usage.reason;
    }
    return source.finish(observation);
  } catch (error) {
    return source.finish(source.error(error instanceof QuotaReadError ? error.code : "invalid_response", error instanceof QuotaReadError ? error.retryable : true));
  }
}

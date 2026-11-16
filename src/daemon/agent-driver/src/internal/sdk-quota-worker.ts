import type { ProbeResult } from "./adapter.js";
import type { SdkWorkerInit } from "./sdk-worker-api.js";
import type { ProviderQuotaObservation, QuotaLimit } from "../contract.js";

export type SdkQuotaResult = ProbeResult & { quota: ProviderQuotaObservation; identity: string };

export async function sdkQuotaWorker(init: SdkWorkerInit): Promise<SdkQuotaResult> {
  type CreditPool = { total?: unknown; cap?: unknown; used?: unknown; remaining?: unknown; unit?: string; available?: boolean };
  type UsageInfo = { userId?: unknown; userType?: unknown; totalUsagePercentage?: unknown; userQuota?: CreditPool; addOnQuota?: CreditPool; orgResourcePackage?: CreditPool };
  type AuthInfo = { type?: unknown; host?: unknown; login?: unknown; token?: unknown; registrationId?: unknown; copilotUser?: { copilot_plan?: unknown } };
  type NativeSdk = {
    CopilotClient: new (options: unknown) => { start(): Promise<void>; stop(): Promise<void>; rpc?: { account?: { getCurrentAuth(): Promise<{ authInfo?: AuthInfo }>; getQuota(options: Record<string, never>): Promise<{ quotaSnapshots?: Record<string, { remainingPercentage?: unknown; resetDate?: unknown; isUnlimitedEntitlement?: boolean; entitlementRequests?: number }> }> } } };
    RuntimeConnection: { forStdio(options: unknown): unknown };
    qodercliAuth(): unknown; accessToken(token: string): unknown; serviceAccount(key: string): unknown;
    startDaemon(options: unknown): Promise<{ getUsageInfo(): Promise<UsageInfo | null>; stop(): Promise<void> }>;
  };
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const sdk = await load(init.moduleUrl) as NativeSdk;
  const { createHash, randomBytes } = await load("node:crypto") as typeof import("node:crypto");
  const sourceEpoch = randomBytes(16).toString("base64url");
  const identity = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const label = (value: unknown): string | undefined => typeof value === "string" && value.trim() && Buffer.byteLength(value.trim()) <= 64 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;
  const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const date = (value: unknown): string | undefined => {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  };
  const error = (code: "unavailable" | "provider_error" | "unauthorized", retryable: boolean, account = "unknown"): SdkQuotaResult => ({ status: "healthy", identity: identity(account), quota: { status: "error", sourceEpoch, code, retryable } });
  let close: (() => Promise<void>) | undefined;
  try {
    let account: string;
    let planName: string | undefined;
    const limits: QuotaLimit[] = [];
    if (typeof sdk.CopilotClient === "function" && typeof sdk.RuntimeConnection?.forStdio === "function") {
      const client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio({ ...(init.config.command ? { path: init.config.command } : {}) }), workingDirectory: init.cwd });
      close = () => client.stop();
      await client.start();
      const api = client.rpc?.account;
      if (typeof api?.getQuota !== "function" || typeof api?.getCurrentAuth !== "function") return error("unavailable", false);
      const auth = (await api.getCurrentAuth())?.authInfo;
      if (!auth) return error("unauthorized", false, "signed-out");
      account = identity([auth.type, auth.host, auth.login, auth.token, auth.registrationId]);
      planName = label(auth.copilotUser?.copilot_plan);
      const data = await api.getQuota({});
      for (const [id, name] of [["premium_interactions", "Premium requests"], ["chat", "Chat requests"], ["completions", "Completions"]]) {
        const row = data?.quotaSnapshots?.[id];
        if (!row || row.isUnlimitedEntitlement === true || row.entitlementRequests === -1) continue;
        const left = number(row.remainingPercentage);
        if (left === undefined || left > 100) continue;
        const resetsAt = date(row.resetDate);
        limits.push({ bucket: { limitId: id, product: { kind: "reported", id: "copilot", displayName: "Copilot" }, model: { kind: "not_applicable" }, window: { kind: "provider_defined", id: "account-quota", displayName: name } }, usedPercent: 100 - left, ...(resetsAt ? { resetsAt } : {}) });
      }
    } else if (typeof sdk.startDaemon === "function" && typeof sdk.qodercliAuth === "function") {
      const token = process.env.QODER_PERSONAL_ACCESS_TOKEN;
      const service = process.env.QODER_SERVICE_ACCOUNT_KEY;
      if (token && service) return error("unavailable", false);
      const auth = service ? sdk.serviceAccount(service) : token ? sdk.accessToken(token) : sdk.qodercliAuth();
      const daemon = await sdk.startDaemon({ auth, env: process.env, launchMode: "process", initializeTimeoutMs: 10_000, ...(init.config.command ? { pathToQoderCLIExecutable: init.config.command } : {}) });
      close = () => daemon.stop();
      if (typeof daemon.getUsageInfo !== "function") return error("unavailable", false);
      const data = await daemon.getUsageInfo();
      if (!data) return error("unavailable", true);
      account = typeof data.userId === "string" && data.userId ? identity([data.userId, token, service]) : randomBytes(32).toString("hex");
      planName = label(data.userType);
      let ratio = number(data.totalUsagePercentage);
      if (ratio === undefined) {
        const pools = [data.userQuota, data.addOnQuota, ...(data.orgResourcePackage?.available === false ? [] : [data.orgResourcePackage])].filter((pool): pool is CreditPool => !!pool);
        const units = new Set(pools.map((row) => row.unit ?? "credits"));
        const amounts = pools.map((row) => {
          const total = number(row.total ?? row.cap);
          const remaining = number(row.remaining);
          const used = number(row.used) ?? (total !== undefined && remaining !== undefined && remaining <= total ? total - remaining : undefined);
          return total !== undefined && used !== undefined && used <= total ? { total, used } : undefined;
        });
        if (amounts.length && units.size === 1 && amounts.every(Boolean)) {
          const total = amounts.reduce((sum, row) => sum + row!.total, 0);
          const used = amounts.reduce((sum, row) => sum + row!.used, 0);
          if (total > 0) ratio = used / total * 100;
        }
      }
      if (ratio !== undefined && ratio <= 100) limits.push({ bucket: { limitId: "total-credits", product: { kind: "reported", id: "qoder", displayName: "Qoder" }, model: { kind: "not_applicable" }, window: { kind: "provider_defined", id: "credits", displayName: "Account credits" } }, usedPercent: ratio });
    } else return error("unavailable", false);
    return { status: "healthy", identity: account, quota: planName || limits.length
      ? { status: "available", sourceEpoch, ...(planName ? { planName } : {}), freshForSeconds: 300, limits }
      : { status: "error", sourceEpoch, code: "unavailable", retryable: true } };
  } catch { return error("provider_error", true); }
  finally { await close?.(); }
}

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as localData from "./local-data.js";
import { parseAntigravityQuota, readAntigravityQuota } from "./quota.js";

const bucket = (bucketId = "gemini-weekly", remainingFraction: unknown = 0.25) => ({ bucketId, displayName: "Gemini models", window: "weekly", remainingFraction, resetTime: "2026-10-05T00:00:00Z" });
let serial = 0;
function fixture(overrides: { auth?: string; credentials?: unknown; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
  const credentials = { client_id: "test-client", client_secret: "test-client-secret", refresh_token: `test-refresh-${++serial}`, project_id: "test-project" };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchUsage = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("/token")) return Response.json({ access_token: "test-access", expires_in: 3600 });
    if (url.endsWith(":loadCodeAssist")) return Response.json({ currentTier: { name: "Free" }, cloudaicompanionProject: "test-project" });
    return Response.json({ groups: [{ displayName: "Gemini", buckets: [bucket()] }] });
  });
  return { credentials, calls, fetchUsage, options: {
    platform: overrides.platform ?? "linux", env: overrides.env ?? {}, home: "/test-home",
    readCredentialsFile: vi.fn(async (path: string) => JSON.stringify(path.endsWith("settings.json") ? { auth: { type: overrides.auth ?? "oauth-personal" } } : overrides.credentials ?? credentials)),
    fetchUsage: overrides.fetch ?? fetchUsage as typeof fetch,
  } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Antigravity official account quota", () => {
  it("maps shared groups without inventing model IDs or window duration and ignores disabled/informational groups", () => {
    expect(parseAntigravityQuota({ groups: [{ displayName: "Information" }, { buckets: [bucket(), { ...bucket("disabled"), disabled: true }, { ...bucket("unspecified", 1), window: "" }] }], buckets: [bucket("deprecated")] }))
      .toEqual([
        { bucket: { limitId: "gemini-weekly", product: { kind: "reported", id: "antigravity", displayName: "Antigravity" }, model: { kind: "unknown" }, window: { kind: "provider_defined", id: "weekly", displayName: "Gemini models" } }, usedPercent: 75, resetsAt: "2026-10-05T00:00:00.000Z" },
        { bucket: { limitId: "unspecified", product: { kind: "reported", id: "antigravity", displayName: "Antigravity" }, model: { kind: "unknown" }, window: { kind: "provider_defined", id: "unspecified", displayName: "Gemini models" } }, usedPercent: 0, resetsAt: "2026-10-05T00:00:00.000Z" },
      ]);
    expect(parseAntigravityQuota({ buckets: [bucket(), bucket()] })).toHaveLength(1);
    expect(parseAntigravityQuota({ buckets: [bucket(), bucket("gemini-weekly", 0.1)] })).toBeUndefined();
    expect(parseAntigravityQuota({ groups: [], buckets: [bucket()] })).toEqual([]);
  });

  it.each([undefined, null, -0.01, 1.01, NaN, Infinity, "0.5"])("rejects unavailable or invalid fractions (%s)", (fraction) => {
    expect(parseAntigravityQuota({ buckets: [{ ...bucket(), remainingFraction: fraction }] })).toBeUndefined();
  });

  it.each([null, {}, { groups: {} }, { groups: [null] }, { groups: [{ buckets: {} }] }, { buckets: [null] }, { buckets: [bucket(), { ...bucket(), resetTime: "invalid" }] }, { buckets: [{ ...bucket(), bucketId: "🙂".repeat(17) }] }, { buckets: Array.from({ length: 9 }, (_, i) => bucket(`bucket-${i}`)) }])("rejects malformed or oversized responses %j", (value) => {
    expect(parseAntigravityQuota(value)).toBeUndefined();
  });

  it("silently refreshes native credentials and queries the native consumer endpoint", async () => {
    const h = fixture(); const observation = await readAntigravityQuota(h.options);
    expect(observation).toMatchObject({ status: "available", planName: "Free", limits: [{ usedPercent: 75 }] });
    expect(h.calls.map((call) => call.url)).toEqual(["https://oauth2.googleapis.com/token", "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"]);
    expect(h.calls[0]!.init?.body).toBeInstanceOf(URLSearchParams);
    expect(new Headers(h.calls[1]!.init?.headers).get("authorization")).toBe("Bearer test-access");
    expect(h.calls[2]!.init?.body).toBe(JSON.stringify({ project: "test-project" }));
    expect(JSON.stringify(observation)).not.toMatch(/test-access|test-refresh|test-client-secret/);
    const second = await readAntigravityQuota(h.options);
    expect(second?.sourceEpoch).toBe(observation.sourceEpoch);
    expect(h.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
  });

  it("uses native macOS keychain identity and GEMINI_HOME, or forced-file storage", async () => {
    const h = fixture({ platform: "darwin", env: { GEMINI_HOME: "~/isolated" } });
    const readKeychain = vi.fn(async () => JSON.stringify(h.credentials));
    expect(await readAntigravityQuota({ ...h.options, readKeychain })).toMatchObject({ status: "available" });
    expect(readKeychain).toHaveBeenCalledOnce();
    expect(h.options.readCredentialsFile.mock.calls.map(([path]) => path)).toEqual([join("/test-home", "isolated", "antigravity-acp", "settings.json")]);
    const f = fixture({ platform: "darwin", env: { AGY_ACP_FORCE_FILE_STORAGE: "1" } });
    expect(await readAntigravityQuota({ ...f.options, readKeychain })).toMatchObject({ status: "available" });
    expect(readKeychain).toHaveBeenCalledOnce();
    expect(await readAntigravityQuota({ ...fixture({ platform: "darwin" }).options, readKeychain: async () => { throw new Error("locked"); } })).toMatchObject({ status: "available" });
  });

  it("does not call account APIs for another auth mode or missing credentials", async () => {
    const h = fixture({ auth: "gemini-api-key" });
    expect(await readAntigravityQuota(h.options)).toMatchObject({ status: "error", code: "unavailable" });
    expect(h.fetchUsage).not.toHaveBeenCalled();
    const f = fixture({ credentials: {} });
    expect(await readAntigravityQuota(f.options)).toMatchObject({ status: "error", code: "unauthorized" });
    expect(f.fetchUsage).not.toHaveBeenCalled();
  });

  it.each(["timeout", "denied"])("keeps Keychain %s plus an absent file locally unavailable and retryable", async (reason) => {
    const h = fixture({ platform: "darwin" });
    h.options.readCredentialsFile.mockImplementation(async (path) => {
      if (path.endsWith("settings.json")) return JSON.stringify({ auth: { type: "oauth-personal" } });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const result = await readAntigravityQuota({ ...h.options, readKeychain: async () => { throw new Error(reason); } });
    expect(result).toMatchObject({ status: "error", code: "unavailable", retryable: true });
    expect(h.fetchUsage).not.toHaveBeenCalled();
  });

  it("keeps unreadable credential storage distinct from readable incomplete or malformed credentials", async () => {
    const h = fixture({ platform: "darwin" });
    h.options.readCredentialsFile.mockImplementation(async (path) => {
      if (path.endsWith("settings.json")) return JSON.stringify({ auth: { type: "oauth-personal" } });
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(await readAntigravityQuota({ ...h.options, readKeychain: async () => { throw new Error("timeout"); } }))
      .toMatchObject({ status: "error", code: "unavailable", retryable: true });
    expect(await readAntigravityQuota({ ...h.options, readKeychain: async () => JSON.stringify({ refresh_token: "incomplete" }) }))
      .toMatchObject({ status: "error", code: "unauthorized", retryable: false });
    h.options.readCredentialsFile.mockImplementation(async (path) => path.endsWith("settings.json") ? JSON.stringify({ auth: { type: "oauth-personal" } }) : "not-json");
    expect(await readAntigravityQuota({ ...h.options, readKeychain: async () => "not-json" }))
      .toMatchObject({ status: "error", code: "unauthorized", retryable: false });
    expect(h.fetchUsage).not.toHaveBeenCalled();
  });

  it("uses a valid native file fallback after a Keychain timeout", async () => {
    const h = fixture({ platform: "darwin" });
    expect(await readAntigravityQuota({ ...h.options, readKeychain: async () => { throw new Error("timeout"); } }))
      .toMatchObject({ status: "available" });
    expect(h.calls.map((call) => call.url)).toEqual(["https://oauth2.googleapis.com/token", "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"]);
  });

  it("keeps a settings read failure retryable without attempting credentials or HTTP", async () => {
    const h = fixture({ platform: "darwin" });
    h.options.readCredentialsFile.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    const readKeychain = vi.fn();
    expect(await readAntigravityQuota({ ...h.options, readKeychain })).toMatchObject({ status: "error", code: "unavailable", retryable: true });
    expect(readKeychain).not.toHaveBeenCalled();
    expect(h.fetchUsage).not.toHaveBeenCalled();
  });

  it.each(["missing", "unreadable", "malformed"])("distinguishes a %s native file when file storage is selected", async (reason) => {
    const h = fixture({ platform: "darwin", env: { AGY_ACP_FORCE_FILE_STORAGE: "1" } });
    h.options.readCredentialsFile.mockImplementation(async (path) => {
      if (path.endsWith("settings.json")) return JSON.stringify({ auth: { type: "oauth-personal" } });
      if (reason === "malformed") return "not-json";
      throw Object.assign(new Error(reason), { code: reason === "missing" ? "ENOENT" : "EACCES" });
    });
    const readKeychain = vi.fn();
    expect(await readAntigravityQuota({ ...h.options, readKeychain })).toMatchObject({
      status: "error", code: reason === "unreadable" ? "unavailable" : "unauthorized", retryable: reason === "unreadable",
    });
    expect(readKeychain).not.toHaveBeenCalled();
    expect(h.fetchUsage).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed"])("does not claim transient storage failure for %s settings", async (reason) => {
    const h = fixture();
    h.options.readCredentialsFile.mockImplementation(async () => {
      if (reason === "malformed") return "not-json";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(await readAntigravityQuota(h.options)).toMatchObject({ status: "error", code: "unavailable", retryable: false });
    expect(h.fetchUsage).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 429, 500])("reports token refresh HTTP %s without returning error body", async (status) => {
    const h = fixture({ fetch: (async () => new Response("sensitive error detail", { status })) as typeof fetch });
    expect(await readAntigravityQuota(h.options)).toMatchObject({ status: "error", code: status < 429 ? "unauthorized" : "provider_error", retryable: status >= 429 });
  });

  it.each(["network", "invalid-token-json", "invalid-token", "missing-project", "denied", "invalid-summary", "empty-summary"])("keeps %s unavailable rather than reporting zero", async (fault) => {
    const h = fixture();
    h.fetchUsage.mockImplementation(async (url) => {
      if (fault === "network") throw new Error("network");
      if (String(url).endsWith("/token")) return fault === "invalid-token-json" ? new Response("bad-json") : Response.json(fault === "invalid-token" ? {} : { access_token: "test-access", expires_in: 3600 });
      if (String(url).endsWith(":loadCodeAssist")) return fault === "missing-project" ? Response.json({}) : fault === "denied" ? new Response("private", { status: 403 }) : Response.json({ currentTier: {}, cloudaicompanionProject: "test-project", paidTier: { usesGcpTos: true } });
      return Response.json(fault === "empty-summary" ? { groups: [] } : {});
    });
    expect(await readAntigravityQuota(h.options)).toMatchObject({ status: "error", code: fault === "network" ? "network" : fault === "missing-project" || fault === "denied" ? "unauthorized" : fault === "empty-summary" ? "unavailable" : "invalid_response" });
  });

  it("fences account changes while the old source is in flight", async () => {
    const old = fixture(); const fresh = fixture();
    let release!: () => void;
    const original = old.fetchUsage.getMockImplementation()!;
    old.fetchUsage.mockImplementation(async (url, init) => {
      if (String(url).endsWith(":retrieveUserQuotaSummary")) await new Promise<void>((resolve) => { release = resolve; });
      return original(url, init);
    });
    const pending = readAntigravityQuota(old.options);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const current = await readAntigravityQuota(fresh.options);
    release();
    expect(await pending).toMatchObject({ status: "error", sourceEpoch: current.sourceEpoch, code: "unavailable" });
  });
});

it("reads native macOS keychain through the owned bounded command helper", async () => {
  const h = fixture({ platform: "darwin" });
  const read = vi.spyOn(localData, "readLocalCommand").mockResolvedValue(JSON.stringify(h.credentials));
  expect(await readAntigravityQuota(h.options)).toMatchObject({ status: "available" });
  expect(read).toHaveBeenCalledWith("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity-acp", "-w"]);
});

it.each(["1", "true", "yes", "YES"])("honors native force-file value %s without reading an old keychain account", async (value) => {
  const h = fixture({ platform: "darwin", env: { AGY_ACP_FORCE_FILE_STORAGE: value } });
  const readKeychain = vi.fn(async () => { throw new Error("must not read keychain"); });
  expect(await readAntigravityQuota({ ...h.options, readKeychain })).toMatchObject({ status: "available" });
  expect(readKeychain).not.toHaveBeenCalled();
});

import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { parseCursorQuota, readCursorQuota } from "./quota.js";

const epoch = "A".repeat(22);
const plan = { planInfo: { planName: "Pro", includedUsagePeriod: 2 }, isMerged: true };
const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;

describe("Cursor machine account quota", () => {
  it("maps merged weekly and separate pools without creating missing usage", () => {
    expect(parseCursorQuota(plan, { planUsage: { totalPercentUsed: 12 }, billingCycleEnd: "1794787200000" }, epoch)).toMatchObject({ status: "available", planName: "Pro", limits: [{ usedPercent: 12, resetsAt: "2026-11-16T00:00:00.000Z", bucket: { window: { kind: "provider_defined", id: "weekly-included" } } }] });
    expect(parseCursorQuota({ ...plan, isMerged: false }, { planUsage: { autoPercentUsed: 0, apiPercentUsed: 95 } }, epoch)).toMatchObject({ limits: [{ usedPercent: 0 }, { usedPercent: 95 }] });
    expect(parseCursorQuota(plan, { planUsage: { totalPercentUsed: "12" } }, epoch)).toMatchObject({ planName: "Pro", limits: [] });
    expect(parseCursorQuota({}, {}, epoch)).toMatchObject({ status: "error", code: "invalid_response" });
  });

  it("uses matching CLI team and native keychain; never sends credentials in observations", async () => {
    const access = token("user-one");
    const fetchUsage = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(plan));
    const readKeychain = vi.fn(async () => access);
    const result = await readCursorQuota({ env: {}, platform: "darwin", home: "/test", readKeychain, readCredentialsFile: async () => JSON.stringify({ authInfo: { authId: "user-one", activeTeamId: 123 } }), fetchUsage: fetchUsage as typeof fetch });
    expect(readKeychain).toHaveBeenCalledWith("cursor-access-token", "cursor-user");
    expect(new Headers(fetchUsage.mock.calls[0]?.[1]?.headers).get("x-cursor-team-id")).toBe("123");
    expect(JSON.stringify(result)).not.toContain(access);
  });

  it("does not borrow CLI credentials for SDK and honors SDK API-key precedence", async () => {
    const paths: string[] = [];
    const calls: { url: string; auth: string | null }[] = [];
    const fetchUsage: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return Response.json(String(url).includes("exchange_user_api_key") ? { accessToken: "exchanged-sdk" } : plan);
    };
    const readKeychain = vi.fn(async () => "wrong-cli");
    const readCredentialsFile = async (path: string) => { paths.push(path); return JSON.stringify({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: "stored-sdk", createdAtMs: 1794787200000 }); };
    expect(await readCursorQuota({ env: {}, home: "/test", readKeychain, readCredentialsFile, fetchUsage }, "cursor-sdk")).toMatchObject({ status: "available", planName: "Pro", limits: [] });
    expect(paths).toEqual([join("/test", ".cursor", "sdk", "auth.json")]);
    expect(readKeychain).not.toHaveBeenCalled();
    expect(calls[0]?.auth).toBe("Bearer stored-sdk");
    expect(calls.slice(1).every((call) => call.auth === "Bearer exchanged-sdk")).toBe(true);
    paths.length = 0;
    await readCursorQuota({ env: { CURSOR_API_KEY: "env-key" }, readCredentialsFile, fetchUsage }, "cursor-sdk");
    expect(paths).toEqual([]);
    expect(calls[3]?.auth).toBe("Bearer env-key");
    paths.length = 0;
    expect(await readCursorQuota({ env: { CURSOR_API_KEY: "" }, readCredentialsFile, fetchUsage }, "cursor-sdk")).toMatchObject({ status: "error", code: "unauthorized" });
    expect(paths).toEqual([]);
  });

  it.each([{ createdAtMs: undefined }, { createdAtMs: "invalid" }, { apiKeyExpiresAtMs: "invalid" }, { apiKeyExpiresAtMs: 1 }, { backendUrl: "https://api.cursor.com" }, { email: 123 }])("rejects a malformed, expired or backend-mismatched SDK login %j", async (patch) => {
    const fetchUsage = vi.fn();
    const readCredentialsFile = async () => JSON.stringify({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: "stored-sdk", createdAtMs: 1794787200000, ...patch });
    expect(await readCursorQuota({ env: {}, readCredentialsFile, fetchUsage }, "cursor-sdk")).toMatchObject({ status: "error" });
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it.each(["file", "memory", "default"])("isolates the native %s credential store on macOS", async (store) => {
    const access = token("keychain-A");
    const readKeychain = vi.fn(async () => access);
    const readCredentialsFile = vi.fn(async (path: string) => {
      if (path.endsWith("cli-config.json")) throw Object.assign(new Error(), { code: "ENOENT" });
      return JSON.stringify({ accessToken: "file-B" });
    });
    const calls: string[] = [];
    const fetchUsage: typeof fetch = async (_url, init) => { calls.push(new Headers(init?.headers).get("authorization") ?? ""); return Response.json(plan); };
    const result = await readCursorQuota({ env: { AGENT_CLI_CREDENTIAL_STORE: store }, platform: "darwin", home: "/test", readKeychain, readCredentialsFile, fetchUsage });
    if (store === "memory") {
      expect(result).toMatchObject({ status: "error", code: "unavailable" });
      expect(readKeychain).not.toHaveBeenCalled();
      expect(readCredentialsFile).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    } else {
      expect(result).toMatchObject({ status: "available" });
      expect(calls).toEqual(Array(2).fill(`Bearer ${store === "file" ? "file-B" : access}`));
      expect(readKeychain).toHaveBeenCalledTimes(store === "file" ? 0 : 1);
      if (store === "default") expect(readCredentialsFile.mock.calls.every(([path]) => path.endsWith("cli-config.json"))).toBe(true);
    }
  });

  it("never falls back from default macOS keychain to a residual file", async () => {
    const readCredentialsFile = vi.fn(async () => JSON.stringify({ accessToken: "residual-file-B" }));
    const fetchUsage = vi.fn();
    for (const readKeychain of [async () => "", async () => { throw new Error("locked"); }]) {
      expect(await readCursorQuota({ env: {}, platform: "darwin", readKeychain, readCredentialsFile, fetchUsage })).toMatchObject({ status: "error" });
    }
    expect(readCredentialsFile).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("refuses custom SDK endpoints, missing auth and unsafe redirects without local fallback", async () => {
    const fetchUsage = vi.fn();
    const readCredentialsFile = vi.fn(async () => { throw Object.assign(new Error(), { code: "ENOENT" }); });
    expect(await readCursorQuota({ env: { CURSOR_BACKEND_URL: "https://other.invalid", CURSOR_API_KEY: "private" }, fetchUsage }, "cursor-sdk")).toMatchObject({ status: "error", code: "unavailable" });
    expect(await readCursorQuota({ env: {}, platform: "linux", readCredentialsFile, fetchUsage })).toMatchObject({ status: "error", code: "unauthorized" });
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(await readCursorQuota({ env: { CURSOR_API_KEY: "private" }, fetchUsage: (async (_url, init) => { expect(init?.redirect).toBe("error"); return new Response(null, { status: 401 }); }) as typeof fetch })).toMatchObject({ status: "error", code: "unauthorized" });
  });

  it("changes account epochs and discards an old request that completes after replacement", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const first = readCursorQuota({ env: { CURSOR_API_KEY: "old-key" }, fetchUsage: (async () => pending) as typeof fetch });
    await Promise.resolve();
    const fresh = await readCursorQuota({ env: { CURSOR_API_KEY: "new-key" }, fetchUsage: (async (url) => Response.json(String(url).includes("exchange_user_api_key") ? { accessToken: "new-access" } : plan)) as typeof fetch });
    resolve(Response.json({ accessToken: "old-access" }));
    expect(await first).toBeNull();
    expect(fresh).toMatchObject({ status: "available" });
    const signedOut = await readCursorQuota({ env: {}, platform: "linux", readCredentialsFile: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } });
    expect(signedOut?.sourceEpoch).not.toBe(fresh?.sourceEpoch);
  });
});

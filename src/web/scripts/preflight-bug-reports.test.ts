import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

interface PreflightResult {
  ok: boolean;
  checks: {
    bucketStandard: boolean;
    managedDomainDisabled: boolean;
    customDomainsEmpty: boolean;
    sevenDayLifecycle: boolean;
  };
}

interface PreflightModule {
  verifyBugReportR2Preflight(args: {
    accountId: string;
    bucketName: string;
    apiToken: string;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
  }): Promise<PreflightResult>;
}

async function loadSubject(): Promise<PreflightModule> {
  return vi.importActual<PreflightModule>("./preflight-bug-reports.js");
}

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "alook-bug-reports";
const TOKEN = "CF_PRIVATE_PREFLIGHT_TOKEN";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`;
const FAILED_CHECKS = {
  bucketStandard: false,
  managedDomainDisabled: false,
  customDomainsEmpty: false,
  sevenDayLifecycle: false,
} as const;

const validResults = {
  [BASE]: { name: BUCKET, storage_class: "Standard" },
  [`${BASE}/domains/managed`]: { bucketId: "bucket-id", domain: `${BUCKET}.r2.dev`, enabled: false },
  [`${BASE}/domains/custom`]: { domains: [] },
  [`${BASE}/lifecycle`]: {
    rules: [{
      id: "delete-bug-reports-after-seven-days",
      enabled: true,
      conditions: { prefix: "bug-reports/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 604_800 } },
    }],
  },
} as const;

function fixtureFetch(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const values: Record<string, unknown> = { ...validResults, ...overrides };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (!(url in values)) return Response.json({ success: false, errors: [] }, { status: 404 });
    return Response.json({ success: true, errors: [], messages: [], result: values[url] });
  });
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

describe("B2d read-only bug-report R2 preflight", () => {
  it("runs the package CLI fail-closed without credentials", () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const secretMarker = "PREFLIGHT_SECRET_MUST_NOT_LEAK";
    const packageManagerCli = process.env.npm_execpath;
    const childArgs = packageManagerCli
      ? [packageManagerCli, "run", "preflight:bug-reports"]
      : [
          fileURLToPath(import.meta.resolve("tsx/cli")),
          fileURLToPath(new URL("./preflight-bug-reports.ts", import.meta.url)),
        ];
    const child = spawnSync(process.execPath, childArgs, {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "",
        CLOUDFLARE_API_TOKEN: "",
        UNRELATED_PREFLIGHT_SECRET: secretMarker,
      },
      timeout: 10_000,
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const jsonLines = child.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
    expect(jsonLines).toHaveLength(1);
    expect(JSON.parse(jsonLines[0] ?? "null")).toEqual({
      ok: false,
      checks: FAILED_CHECKS,
    });
    expect(`${child.stdout}\n${child.stderr}`).not.toContain(secretMarker);
  });

  it("passes only the exact private Standard bucket and seven-day lifecycle contract", async () => {
    const api = await loadSubject();
    const fixture = fixtureFetch();
    const logs: string[] = [];

    await expect(api.verifyBugReportR2Preflight({
      accountId: ACCOUNT,
      bucketName: BUCKET,
      apiToken: TOKEN,
      fetchImpl: fixture.fetchImpl,
      log: (message) => logs.push(message),
    })).resolves.toEqual({
      ok: true,
      checks: {
        bucketStandard: true,
        managedDomainDisabled: true,
        customDomainsEmpty: true,
        sevenDayLifecycle: true,
      },
    });

    expect(fixture.calls.map((call) => call.url)).toEqual([
      BASE,
      `${BASE}/domains/managed`,
      `${BASE}/domains/custom`,
      `${BASE}/lifecycle`,
    ]);
    for (const call of fixture.calls) {
      expect(call.init?.method ?? "GET").toBe("GET");
      expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.init?.body).toBeUndefined();
    }
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it.each([
    ["bucket missing", { [BASE]: undefined }],
    ["non-Standard default", { [BASE]: { name: BUCKET, storage_class: "InfrequentAccess" } }],
    ["missing storage class", { [BASE]: { name: BUCKET } }],
    ["r2.dev enabled", { [`${BASE}/domains/managed`]: { enabled: true } }],
    ["managed response malformed", { [`${BASE}/domains/managed`]: {} }],
    ["one custom domain", { [`${BASE}/domains/custom`]: { domains: [{ domain: "public.example", enabled: false }] } }],
    ["custom response malformed", { [`${BASE}/domains/custom`]: {} }],
    ["lifecycle missing", { [`${BASE}/lifecycle`]: { rules: [] } }],
    ["lifecycle disabled", { [`${BASE}/lifecycle`]: { rules: [{
      enabled: false,
      conditions: { prefix: "bug-reports/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 604_800 } },
    }] } }],
    ["wrong prefix", { [`${BASE}/lifecycle`]: { rules: [{
      enabled: true,
      conditions: { prefix: "" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 604_800 } },
    }] } }],
    ["wrong age", { [`${BASE}/lifecycle`]: { rules: [{
      enabled: true,
      conditions: { prefix: "bug-reports/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 604_801 } },
    }] } }],
    ["date transition", { [`${BASE}/lifecycle`]: { rules: [{
      enabled: true,
      conditions: { prefix: "bug-reports/" },
      deleteObjectsTransition: { condition: { type: "Date", date: "2026-08-19T00:00:00Z" } },
    }] } }],
    ["duplicate matching rules", { [`${BASE}/lifecycle`]: { rules: [
      validResults[`${BASE}/lifecycle`].rules[0],
      validResults[`${BASE}/lifecycle`].rules[0],
    ] } }],
    ["additional deletion rule", { [`${BASE}/lifecycle`]: { rules: [
      validResults[`${BASE}/lifecycle`].rules[0],
      {
        enabled: true,
        conditions: { prefix: "" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
      },
    ] } }],
  ])("fails closed for %s", async (_name, overrides) => {
    const api = await loadSubject();
    const fixture = fixtureFetch(overrides);

    const result = await api.verifyBugReportR2Preflight({
      accountId: ACCOUNT,
      bucketName: BUCKET,
      apiToken: TOKEN,
      fetchImpl: fixture.fetchImpl,
    });

    expect(result.ok).toBe(false);
  });

  it("fails closed on non-OK, API success=false, malformed JSON, and network errors", async () => {
    const api = await loadSubject();
    const outcomes = [
      vi.fn(async () => new Response("unavailable", { status: 503 })),
      vi.fn(async () => Response.json({ success: false, result: null, errors: [{ message: TOKEN }] })),
      vi.fn(async () => new Response("{", { status: 200 })),
      vi.fn(async () => { throw new Error(`network ${TOKEN}`); }),
    ];

    for (const fetchImpl of outcomes) {
      const logs: string[] = [];
      await expect(api.verifyBugReportR2Preflight({
        accountId: ACCOUNT,
        bucketName: BUCKET,
        apiToken: TOKEN,
        fetchImpl: fetchImpl as typeof fetch,
        log: (message) => logs.push(message),
      })).resolves.toMatchObject({ ok: false });
      expect(JSON.stringify(logs)).not.toContain(TOKEN);
    }
  });

  it("rejects unsafe or missing inputs before any network request", async () => {
    const api = await loadSubject();
    const fetchImpl = vi.fn();

    for (const [accountId, bucketName, apiToken] of [
      ["../account", BUCKET, TOKEN],
      [ACCOUNT, "../bucket", TOKEN],
      ["", BUCKET, TOKEN],
      [ACCOUNT, "", TOKEN],
      [ACCOUNT, BUCKET, ""],
      [ACCOUNT, BUCKET, "   "],
    ]) {
      await expect(api.verifyBugReportR2Preflight({
        accountId,
        bucketName,
        apiToken,
        fetchImpl: fetchImpl as typeof fetch,
      })).resolves.toMatchObject({ ok: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

import { pathToFileURL } from "node:url";

interface CloudflareEnvelope {
  success?: unknown;
  result?: unknown;
}

export interface BugReportPreflightResult {
  ok: boolean;
  checks: {
    bucketStandard: boolean;
    managedDomainDisabled: boolean;
    customDomainsEmpty: boolean;
    sevenDayLifecycle: boolean;
  };
}

const failedChecks = (): BugReportPreflightResult["checks"] => ({
  bucketStandard: false,
  managedDomainDisabled: false,
  customDomainsEmpty: false,
  sevenDayLifecycle: false,
});

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readResult(
  fetchImpl: typeof fetch,
  url: string,
  apiToken: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { authorization: `Bearer ${apiToken}` },
  });
  if (!response.ok) throw new Error("Cloudflare API request failed");
  const envelope = await response.json() as CloudflareEnvelope;
  if (envelope.success !== true || !("result" in envelope)) {
    throw new Error("Cloudflare API response was unsuccessful");
  }
  return envelope.result;
}

export async function verifyBugReportR2Preflight(args: {
  accountId: string;
  bucketName: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<BugReportPreflightResult> {
  const fail = (): BugReportPreflightResult => ({ ok: false, checks: failedChecks() });
  if (!/^[0-9a-f]{32}$/.test(args.accountId)
    || !/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/.test(args.bucketName)
    || args.apiToken.trim().length === 0) {
    return fail();
  }

  const fetchImpl = args.fetchImpl ?? fetch;
  const base = `https://api.cloudflare.com/client/v4/accounts/${args.accountId}/r2/buckets/${args.bucketName}`;
  try {
    const bucket = record(await readResult(fetchImpl, base, args.apiToken));
    const managed = record(await readResult(fetchImpl, `${base}/domains/managed`, args.apiToken));
    const custom = record(await readResult(fetchImpl, `${base}/domains/custom`, args.apiToken));
    const lifecycle = record(await readResult(fetchImpl, `${base}/lifecycle`, args.apiToken));

    const rules = Array.isArray(lifecycle?.rules) ? lifecycle.rules : [];
    const matchingRules = rules.filter((value) => {
      const rule = record(value);
      const conditions = record(rule?.conditions);
      const transition = record(rule?.deleteObjectsTransition);
      const condition = record(transition?.condition);
      return rule?.enabled === true
        && conditions?.prefix === "bug-reports/"
        && condition?.type === "Age"
        && condition?.maxAge === 604_800;
    });
    const checks = {
      bucketStandard: bucket?.storage_class === "Standard",
      managedDomainDisabled: managed?.enabled === false,
      customDomainsEmpty: Array.isArray(custom?.domains) && custom.domains.length === 0,
      sevenDayLifecycle: rules.length === 1 && matchingRules.length === 1,
    };
    return { ok: Object.values(checks).every(Boolean), checks };
  } catch {
    args.log?.("bug-report R2 preflight failed closed");
    return fail();
  }
}

async function main(): Promise<void> {
  const result = await verifyBugReportR2Preflight({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    bucketName: process.env.BUG_REPORTS_BUCKET_NAME ?? "alook-bug-reports",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    log: (message) => process.stderr.write(`${message}\n`),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => {
    process.stderr.write("bug-report R2 preflight failed closed\n");
    process.stdout.write(`${JSON.stringify({ ok: false, checks: failedChecks() })}\n`);
    process.exitCode = 1;
  });
}

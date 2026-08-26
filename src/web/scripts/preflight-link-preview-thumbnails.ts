import { pathToFileURL } from "node:url"

const THUMBNAIL_PREFIX = "link-preview-thumbnails/v1/"
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60

type CloudflareEnvelope = { success?: unknown; result?: unknown }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export async function verifyLinkPreviewThumbnailLifecycle(args: {
  accountId: string
  bucketName: string
  apiToken: string
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}): Promise<{ ok: boolean; sevenDayLifecycle: boolean }> {
  const fail = () => ({ ok: false, sevenDayLifecycle: false })
  if (!/^[0-9a-f]{32}$/.test(args.accountId)
    || !/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/.test(args.bucketName)
    || args.apiToken.trim().length === 0) {
    return fail()
  }

  try {
    const fetchImpl = args.fetchImpl ?? fetch
    const url = `https://api.cloudflare.com/client/v4/accounts/${args.accountId}/r2/buckets/${args.bucketName}/lifecycle`
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${args.apiToken}` },
    })
    if (!response.ok) return fail()
    const envelope = await response.json() as CloudflareEnvelope
    const lifecycle = envelope.success === true ? record(envelope.result) : null
    const rules = Array.isArray(lifecycle?.rules) ? lifecycle.rules : []
    const matches = rules.filter((value) => {
      const rule = record(value)
      const conditions = record(rule?.conditions)
      const transition = record(rule?.deleteObjectsTransition)
      const condition = record(transition?.condition)
      return rule?.enabled === true
        && conditions?.prefix === THUMBNAIL_PREFIX
        && condition?.type === "Age"
        && condition?.maxAge === SEVEN_DAYS_SECONDS
    })
    const sevenDayLifecycle = matches.length === 1
    return { ok: sevenDayLifecycle, sevenDayLifecycle }
  } catch {
    args.log?.("link-preview thumbnail R2 preflight failed closed")
    return fail()
  }
}

async function main(): Promise<void> {
  const result = await verifyLinkPreviewThumbnailLifecycle({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    bucketName: process.env.COMMUNITY_MEDIA_BUCKET_NAME ?? "alook-community-media",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    log: (message) => process.stderr.write(`${message}\n`),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.ok) process.exitCode = 1
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => {
    process.stderr.write("link-preview thumbnail R2 preflight failed closed\n")
    process.stdout.write(`${JSON.stringify({ ok: false, sevenDayLifecycle: false })}\n`)
    process.exitCode = 1
  })
}

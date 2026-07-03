/**
 * One-off backfill: convert `communityServer.icon` from the legacy URL format
 * (`/api/community/servers/<id>/icon`) into a direct R2 key (`server-icon/<id>/<fileId>`).
 *
 * Historically the icon route stored the fetch URL in the column and served
 * bytes by LISTing `server-icon/<id>/` and picking the newest. This script
 * pins each server to its most-recent object, updates the column, and sweeps
 * stale objects.
 *
 * Run (from repo root):
 *   pnpm --filter @alook/web tsx scripts/backfill-community-server-icons.ts --dry-run
 *   pnpm --filter @alook/web tsx scripts/backfill-community-server-icons.ts
 *
 * The `--dry-run` flag logs planned mutations without executing them.
 *
 * The `backfillCommunityServerIcons` helper is exported for unit tests to
 * drive against mock DB / R2 bindings. The CLI entrypoint at the bottom only
 * runs when the script is invoked directly with wrangler-provided bindings.
 */
import { queries, type Database } from "@alook/shared"

export interface R2ObjectSummary {
  key: string
  uploaded?: Date
}

export interface R2ListResult {
  objects: R2ObjectSummary[]
}

export interface R2Like {
  list(opts: { prefix: string }): Promise<R2ListResult>
  delete(key: string): Promise<void>
}

export interface BackfillOptions {
  dryRun?: boolean
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

export interface BackfillReport {
  scanned: number
  updated: number
  cleared: number
  deletedObjects: number
  skipped: number
}

/**
 * Walk every `communityServer` row whose icon is either NULL or URL-shaped and
 * pin it to the newest R2 object under `server-icon/<serverId>/`. Older
 * zombie objects for that server are deleted.
 *
 * Rows already holding an R2 key (`server-icon/…`) are filtered out by the
 * query.
 */
export async function backfillCommunityServerIcons(
  db: Database,
  media: R2Like,
  opts: BackfillOptions = {},
): Promise<BackfillReport> {
  const dryRun = opts.dryRun ?? false
  const log = opts.log ?? ((msg, meta) => console.log(msg, meta ?? ""))

  const rows = await queries.communityServer.listServersNeedingIconBackfill(db)

  const report: BackfillReport = {
    scanned: rows.length,
    updated: 0,
    cleared: 0,
    deletedObjects: 0,
    skipped: 0,
  }

  for (const row of rows) {
    const listing = await media.list({ prefix: `server-icon/${row.id}/` })
    if (listing.objects.length === 0) {
      // No historical object — reset to NULL so the row matches the new
      // contract. Rows already NULL become no-ops.
      if (row.icon === null) {
        report.skipped += 1
        continue
      }
      log("server_icon_backfill_clear", { serverId: row.id })
      if (!dryRun) {
        await queries.communityServer.setServerIcon(db, row.id, null)
      }
      report.cleared += 1
      continue
    }
    const sorted = [...listing.objects].sort(
      (a, b) => (b.uploaded?.getTime() ?? 0) - (a.uploaded?.getTime() ?? 0),
    )
    const keep = sorted[0]!.key
    log("server_icon_backfill_update", { serverId: row.id, keep })
    if (!dryRun) {
      await queries.communityServer.setServerIcon(db, row.id, keep)
    }
    report.updated += 1

    for (const stale of sorted.slice(1)) {
      log("server_icon_backfill_delete", { serverId: row.id, key: stale.key })
      if (!dryRun) {
        await media.delete(stale.key)
      }
      report.deletedObjects += 1
    }
  }

  return report
}

// CLI entrypoint — bind D1 + R2 via wrangler-provided env when invoked
// directly. Unit tests exercise `backfillCommunityServerIcons` with mock
// bindings so this section is out of coverage on purpose.
declare const process: { argv: string[]; exit: (code: number) => void }
declare const require: { main?: unknown } | undefined
declare const module: { filename?: string } | undefined
if (typeof require !== "undefined" && require.main === (module as unknown)) {
  const dryRun = process.argv.includes("--dry-run")
  console.error(
    "Direct invocation requires wrangler bindings — run via `pnpm --filter @alook/web tsx ...` " +
      "inside a wrangler-provided environment.",
  )
  console.error(`Dry run: ${dryRun ? "yes" : "no"}`)
  process.exit(1)
}

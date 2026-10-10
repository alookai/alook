import { createHash } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

type FileRow = { id: string; r2_key: string; thumbnail_r2_key: string | null; size: number | null }
type Bindings = { DB: D1Database; COMMUNITY_MEDIA: R2Bucket }
type RecordEntry = { operation: string; id?: string; from?: string; to?: string; sha256?: string; size?: number; deleted?: boolean }
type MaintenanceOptions = { apply: boolean; beforeWrite?: () => Promise<void>; record: (entry: RecordEntry) => Promise<void> }

async function requireQuiet(options: MaintenanceOptions) {
  if (!options.beforeWrite) throw new Error("mutation requires a current quiescence check")
  await options.beforeWrite()
}

async function objectDigest(object: R2ObjectBody) {
  const hash = createHash("sha256")
  let size = 0
  const reader = object.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      hash.update(value)
    }
  } finally {
    reader.releaseLock()
  }
  return { sha256: hash.digest("hex"), size }
}

async function migrateObject(bucket: R2Bucket, key: string, prefix: string, options: MaintenanceOptions) {
  const source = await bucket.get(key)
  if (!source) throw new Error(`missing attachment object: ${key}`)
  const digest = await objectDigest(source)
  const target = `${prefix}/sha256/${digest.sha256}`
  if (options.apply && target !== key) {
    const sourceAgain = await bucket.get(key, { onlyIf: { etagMatches: source.etag } })
    if (!sourceAgain || !("body" in sourceAgain)) throw new Error(`attachment object changed: ${key}`)
    await requireQuiet(options)
    await bucket.put(target, sourceAgain.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest.sha256,
    })
  }
  if (options.apply) {
    const copied = await bucket.get(target)
    if (!copied) throw new Error(`missing migrated object: ${target}`)
    const verified = await objectDigest(copied)
    if (verified.size !== digest.size || verified.sha256 !== digest.sha256) {
      throw new Error(`migrated attachment checksum mismatch: ${target}`)
    }
  }
  return { from: key, to: target, ...digest }
}

export async function migrateAttachmentObjects(env: Bindings, options: MaintenanceOptions) {
  let after = ""
  let count = 0
  for (;;) {
    const page = await env.DB.prepare("SELECT id, r2_key, thumbnail_r2_key, size FROM community_attachment WHERE id > ? ORDER BY id LIMIT 100").bind(after).all<FileRow>()
    if (page.results.length === 0) break
    for (const file of page.results) {
      const original = await migrateObject(env.COMMUNITY_MEDIA, file.r2_key, "attachments", options)
      if (file.size !== null && file.size !== original.size) throw new Error(`attachment size mismatch: ${file.id}`)
      const thumbnail = file.thumbnail_r2_key
        ? await migrateObject(env.COMMUNITY_MEDIA, file.thumbnail_r2_key, "attachment-thumbnails", options)
        : null
      await options.record({ operation: "original", id: file.id, ...original })
      if (thumbnail) await options.record({ operation: "thumbnail", id: file.id, ...thumbnail })
      if (options.apply) {
        await requireQuiet(options)
        const changed = await env.DB.prepare("UPDATE community_attachment SET r2_key = ?, thumbnail_r2_key = ? WHERE id = ? AND r2_key = ? AND thumbnail_r2_key IS ?")
          .bind(original.to, thumbnail?.to ?? null, file.id, file.r2_key, file.thumbnail_r2_key).run()
        if (changed.meta.changes !== 1) throw new Error(`attachment compare-and-swap failed: ${file.id}`)
      }
      await options.record({ operation: options.apply ? "checkpoint" : "audit", id: file.id })
      after = file.id
      count++
    }
  }
  return count
}

export async function collectAttachmentObjects(env: Bindings, options: MaintenanceOptions, oldKeys: ReadonlySet<string> = new Set()) {
  let cursor: string | undefined
  const candidates = new Set(oldKeys)
  for (const prefix of ["attachments/sha256/", "attachment-thumbnails/sha256/"]) {
    cursor = undefined
    do {
      const page = await env.COMMUNITY_MEDIA.list({ prefix, cursor })
      for (const object of page.objects) candidates.add(object.key)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  let count = 0
  for (const key of candidates) {
    const reference = await env.DB.prepare("SELECT id FROM community_attachment WHERE r2_key = ? OR thumbnail_r2_key = ? LIMIT 1").bind(key, key).first<{ id: string }>()
    if (reference) continue
    if (!/^(attachments\/sha256\/|attachment-thumbnails\/sha256\/|channel\/|dm\/|thread\/)/.test(key)) throw new Error("collection key is outside attachment namespaces")
    if (options.apply) { await requireQuiet(options); await env.COMMUNITY_MEDIA.delete(key) }
    await options.record({ operation: "collect", from: key, deleted: options.apply })
    count++
  }
  return count
}

export function assertLocalMaintenance(config: { d1_databases?: { remote?: boolean }[]; r2_buckets?: { remote?: boolean }[] }) {
  if ([...(config.d1_databases ?? []), ...(config.r2_buckets ?? [])].some(binding => binding.remote)) {
    throw new Error("production/remote apply is disabled: no verified invocation drain mechanism")
  }
}

async function main() {
  const args = process.argv.slice(2)
  const value = (name: string) => args[args.indexOf(name) + 1]
  const mode = args[0]
  if (!["audit", "migrate", "collect"].includes(mode ?? "") || !args.includes("--config") || !args.includes("--manifest")) {
    throw new Error("usage: attachment-maintenance.ts audit|migrate|collect --config <isolated-or-approved-wrangler-config> --manifest <jsonl> [--apply --local-state <path> --quiescence-proof <local-stopped-writers-json>] [--old-manifest <jsonl>]")
  }
  const apply = args.includes("--apply")
  if (mode === "audit" && apply) throw new Error("audit does not mutate")
  const configPath = resolve(value("--config"))
  const beforeWrite = async () => {
    if (!args.includes("--quiescence-proof")) throw new Error("apply requires verified stopped writers and drained invocations")
    const proof = JSON.parse(await readFile(value("--quiescence-proof"), "utf8"))
    if (proof.localState !== (args.includes("--local-state") ? resolve(value("--local-state")) : null)
      || !Array.isArray(proof.stoppedWriterPids) || proof.stoppedWriterPids.length === 0
      || proof.configPath !== configPath || !proof.writersStopped || !proof.invocationsDrained
      || !proof.evidence || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= Date.now()) {
      throw new Error("missing, expired or mismatched local quiescence proof; dry-run only")
    }
    for (const pid of proof.stoppedWriterPids) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid stopped writer PID")
      try { process.kill(pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") continue
        throw error
      }
      throw new Error(`writer process is still running: ${pid}`)
    }
  }
  if (apply) await beforeWrite()
  const oldKeys = new Set<string>()
  if (args.includes("--old-manifest")) {
    for (const line of (await readFile(value("--old-manifest"), "utf8")).split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as RecordEntry
      if (["original", "thumbnail"].includes(entry.operation) && entry.from) oldKeys.add(entry.from)
    }
  }
  const { getPlatformProxy, unstable_readConfig } = await import("wrangler")
  const config = unstable_readConfig({ config: configPath }, { hideWarnings: true })
  if (apply) {
    assertLocalMaintenance(config)
    if (!args.includes("--local-state")) throw new Error("apply is local-only and requires --local-state")
  }
  const proxy = await getPlatformProxy<Bindings>({
    configPath, envFiles: [], remoteBindings: !apply,
    persist: args.includes("--local-state") ? { path: resolve(value("--local-state")) } : true,
  })
  try {
    const record = async (entry: RecordEntry) => { await appendFile(value("--manifest"), `${JSON.stringify(entry)}\n`, { mode: 0o600 }) }
    const options = { apply, record, beforeWrite }
    const count = mode === "collect"
      ? await collectAttachmentObjects(proxy.env, options, oldKeys)
      : await migrateAttachmentObjects(proxy.env, options)
    console.log(JSON.stringify({ mode, apply, storage: apply ? "local-only" : "configured-read-only", count }))
  } finally {
    await proxy.dispose()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "attachment maintenance failed"); process.exitCode = 1 })
}

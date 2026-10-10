import { appendFile, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

type Bindings = { DB: D1Database; COMMUNITY_MEDIA: R2Bucket }
type RecordEntry = { operation: "collect"; from: string; deleted: boolean }
type MaintenanceOptions = { apply: boolean; beforeWrite?: () => Promise<void>; record: (entry: RecordEntry) => Promise<void> }

async function requireQuiet(options: MaintenanceOptions) {
  if (!options.beforeWrite) throw new Error("mutation requires a current quiescence check")
  await options.beforeWrite()
}

export async function collectAttachmentObjects(env: Bindings, options: MaintenanceOptions, specifiedKeys: ReadonlySet<string> = new Set()) {
  let cursor: string | undefined
  const candidates = new Set(specifiedKeys)
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
  if (mode !== "collect" || !args.includes("--config") || !args.includes("--manifest")) {
    throw new Error("usage: attachment-maintenance.ts collect --config <isolated-or-approved-wrangler-config> --manifest <jsonl> [--apply --local-state <path> --quiescence-proof <local-stopped-writers-json>] [--candidate-keys <newline-separated-keys>]")
  }
  const apply = args.includes("--apply")
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
  const specifiedKeys = args.includes("--candidate-keys")
    ? new Set((await readFile(value("--candidate-keys"), "utf8")).split("\n").filter(Boolean))
    : new Set<string>()
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
    const count = await collectAttachmentObjects(proxy.env, options, specifiedKeys)
    console.log(JSON.stringify({ mode, apply, storage: apply ? "local-only" : "configured-read-only", count }))
  } finally {
    await proxy.dispose()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "attachment maintenance failed"); process.exitCode = 1 })
}

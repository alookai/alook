import { appendFileSync, readdirSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const E2E_SPEC_ROOT = "src/web/src/test/e2e-ui"
export const E2E_SHARD_COUNT = 2
export const DEFAULT_SPEC_SECONDS = 60

export const SPEC_SECONDS = {
  "01-auth.spec.ts": 5,
  "02-server-channel-message.spec.ts": 75,
  "03-realtime-multiuser.spec.ts": 63,
  "04-dm.spec.ts": 42,
  "05-mention-bot.spec.ts": 15,
  "06-channel-member-admin.spec.ts": 17,
  "07-invite.spec.ts": 10,
  "08-mobile.spec.ts": 7,
  "09-forum-thread.spec.ts": 35,
  "10-eject-nav-auth.spec.ts": 30,
  "11-profile-ui-stability.spec.ts": 9,
  "12-friends.spec.ts": 6,
  "13-mentions.spec.ts": 50,
  "14-forum-post-tags-presence.spec.ts": 59,
  "15-mention-scope.spec.ts": 74,
  "16-jump-to-present.spec.ts": 30,
  "17-forum-sidebar-stage-b.spec.ts": 35,
  "18-new-divider-scroll.spec.ts": 46,
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

export function discoverE2eSpecs(root = resolve(E2E_SPEC_ROOT)) {
  return walk(root)
    .filter((path) => path.endsWith(".spec.ts"))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .sort()
}

export function planE2eShards(
  specs,
  shardCount = E2E_SHARD_COUNT,
  weights = SPEC_SECONDS,
  defaultSeconds = DEFAULT_SPEC_SECONDS,
) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("shardCount must be a positive integer")
  }

  const uniqueSpecs = [...new Set(specs)]
  if (uniqueSpecs.length !== specs.length) {
    throw new Error("spec paths must be unique")
  }
  if (uniqueSpecs.length === 0) {
    throw new Error("at least one spec is required")
  }

  const effectiveShardCount = Math.min(shardCount, uniqueSpecs.length)
  const shards = Array.from({ length: effectiveShardCount }, (_, index) => ({
    shard: index + 1,
    predicted_seconds: 0,
    files: [],
  }))

  const weighted = uniqueSpecs
    .map((path) => ({ path, seconds: weights[path] ?? defaultSeconds }))
    .sort((left, right) => right.seconds - left.seconds || left.path.localeCompare(right.path))

  for (const spec of weighted) {
    const target = [...shards].sort(
      (left, right) => left.predicted_seconds - right.predicted_seconds || left.shard - right.shard,
    )[0]
    target.files.push(spec.path)
    target.predicted_seconds += spec.seconds
  }

  return shards.map((shard) => ({
    ...shard,
    files: shard.files.sort(),
  }))
}

export function createE2eMatrix(specs = discoverE2eSpecs()) {
  const shards = planE2eShards(specs)
  return {
    include: shards.map((shard) => ({
      shard: shard.shard,
      total: shards.length,
      predicted_seconds: shard.predicted_seconds,
      specs: shard.files.map((path) => `src/test/e2e-ui/${path}`),
    })),
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    args[key] = argv[++index]
  }
  return args
}

function writeSummary(path, matrix) {
  const rows = matrix.include
    .map((shard) => `| ${shard.shard}/${shard.total} | ${shard.predicted_seconds}s | \`${shard.specs.join(" ")}\` |`)
    .join("\n")
  appendFileSync(
    path,
    `## UI E2E shards\n\n| Shard | Predicted | Specs |\n| --- | ---: | --- |\n${rows}\n`,
  )
}

export function runCli(argv) {
  const args = parseArgs(argv)
  const matrix = createE2eMatrix()
  const json = JSON.stringify(matrix)
  if (args.output) appendFileSync(args.output, `e2e_matrix=${json}\n`)
  if (args.summary) writeSummary(args.summary, matrix)
  if (!args.output) process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
}

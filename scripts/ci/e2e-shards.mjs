import { appendFileSync, readFileSync, readdirSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const E2E_SPEC_ROOT = "src/web/src/test/e2e-ui"
export const E2E_SHARD_COUNT = 5
export const DEFAULT_SPEC_SECONDS = 60
export const PLAYWRIGHT_IMAGE_REPOSITORY = "mcr.microsoft.com/playwright"

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
  "19-marketing-seo.spec.ts": 5,
  "20-community-attachment-thumbnails.spec.ts": 60,
  "21-mobile-message-layout.spec.ts": 20,
  "22-committed-message-delivery.spec.ts": 85,
  "23-message-selection-context-menu.spec.ts": 10,
  "24-composer-overflow.spec.ts": 35,
  "25-community-ws-reconnect-overlay.spec.ts": 60,
  "25-composer-accessory-rail-occupancy.spec.ts": 95,
  "26-mobile-forum-post-actions.spec.ts": 45,
  "27-canonical-forum-post-delete.spec.ts": 30,
  "28-community-delete-media-cleanup.spec.ts": 45,
  "29-community-bot-avatar-cleanup.spec.ts": 15,
  "29-multi-device-read-state.spec.ts": 45,
  "30-bot-profile-audit-preview.spec.ts": 35,
  "31-mention-candidate-pagination.spec.ts": 10,
  "31-machine-guide-motion.spec.ts": 10,
  "32-mobile-ws-foreground-validation.spec.ts": 80,
  "33-picker-async-layout.spec.ts": 57,
  "34-inbox-read-race.spec.ts": 42,
  "35-channel-ref-directory-states.spec.ts": 60,
  "36-server-switch-pending-checkpoint.spec.ts": 60,
  "37-server-rail-pdd.spec.ts": 10,
  "38-community-navigation-checkpoint-matrix.spec.ts": 60,
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

export function resolvePlaywrightVersion(lockfile = readFileSync(resolve("pnpm-lock.yaml"), "utf8")) {
  const normalizedLockfile = lockfile.replaceAll("\r\n", "\n")
  const importerStart = normalizedLockfile.indexOf("\n  src/web:\n")
  if (importerStart < 0) throw new Error("pnpm lockfile is missing the src/web importer")

  const importerBody = normalizedLockfile.slice(importerStart + 1)
  const nextImporter = importerBody.slice(1).search(/\n  \S[^\n]*:\n/)
  const importer = nextImporter < 0
    ? importerBody
    : importerBody.slice(0, nextImporter + 1)
  const dependency = importer.match(
    /\n      '@playwright\/test':\n(?:        [^\n]*\n)*?        version: ([^\s(]+)/,
  )
  if (!dependency) throw new Error("src/web importer is missing an exact @playwright/test version")
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(dependency[1])) {
    throw new Error(`invalid @playwright/test version: ${dependency[1]}`)
  }
  return dependency[1]
}

export function resolvePlaywrightImage(lockfile) {
  return `${PLAYWRIGHT_IMAGE_REPOSITORY}:v${resolvePlaywrightVersion(lockfile)}-noble`
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

export function createE2eMatrix(specs = discoverE2eSpecs(), image = resolvePlaywrightImage()) {
  const shards = planE2eShards(specs)
  return {
    include: shards.map((shard) => ({
      shard: shard.shard,
      total: shards.length,
      image,
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

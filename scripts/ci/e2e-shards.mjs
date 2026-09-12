import { appendFileSync, readFileSync, readdirSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const E2E_SPEC_ROOT = "src/web/src/test/e2e-ui"
export const E2E_SHARD_BUDGET_SECONDS = 240
export const E2E_FIXED_SETUP_SECONDS = 60
export const E2E_SAFETY_MARGIN_SECONDS = 15
export const E2E_SPEC_BUDGET_SECONDS = E2E_SHARD_BUDGET_SECONDS
  - E2E_FIXED_SETUP_SECONDS
  - E2E_SAFETY_MARGIN_SECONDS
export const DEFAULT_SPEC_SECONDS = E2E_SPEC_BUDGET_SECONDS
export const PLAYWRIGHT_IMAGE_REPOSITORY = "mcr.microsoft.com/playwright"

export const SPEC_SECONDS = {
  "01-auth.spec.ts": 3.997,
  "02-server-channel-message.spec.ts": 9.687,
  "03-realtime-multiuser.spec.ts": 13.037,
  "04-dm.spec.ts": 15.545,
  "05-mention-bot.spec.ts": 4.117,
  "06-channel-member-admin.spec.ts": 3.819,
  "07-invite.spec.ts": 9.843,
  "08-mobile.spec.ts": 37.929,
  "09-forum-thread.spec.ts": 4.538,
  "10-eject-nav-auth.spec.ts": 6.193,
  "11-profile-ui-stability.spec.ts": 2.554,
  "12-friends.spec.ts": 3.905,
  "13-mentions.spec.ts": 9.591,
  "14-forum-post-tags-presence.spec.ts": 16.213,
  "15-mention-scope.spec.ts": 10.94,
  "16-jump-to-present.spec.ts": 5.997,
  "17-forum-sidebar-stage-b.spec.ts": 43.842,
  "18-new-divider-scroll.spec.ts": 10.956,
  "19-marketing-seo.spec.ts": 1.713,
  "20-community-attachment-thumbnails.spec.ts": 11.117,
  "21-mobile-message-layout.spec.ts": 5.12,
  "22-committed-message-delivery.spec.ts": 40.086,
  "23-message-selection-context-menu.spec.ts": 3.392,
  "24-composer-overflow.spec.ts": 12.763,
  "25-community-ws-reconnect-overlay.spec.ts": 36.437,
  "25-composer-accessory-rail-occupancy.spec.ts": 40.804,
  "26-mobile-forum-post-actions.spec.ts": 21.297,
  "27-canonical-forum-post-delete.spec.ts": 11.097,
  "28-community-delete-media-cleanup.spec.ts": 11.925,
  "28-thread-realtime-audiences.spec.ts": 26.477,
  "29-community-bot-avatar-cleanup.spec.ts": 8.216,
  "29-multi-device-read-state.spec.ts": 72.169,
  "30-bot-profile-audit-preview.spec.ts": 29.213,
  "31-machine-guide-motion.spec.ts": 4.201,
  "31-mention-candidate-pagination.spec.ts": 3.836,
  "32-mobile-ws-foreground-validation.spec.ts": 95.792,
  "33-picker-async-layout.spec.ts": 18.776,
  "34-inbox-read-race.spec.ts": 26.519,
  "35-bot-token-usage-quota.spec.ts": 10.867,
  "35-channel-ref-directory-states.spec.ts": 12.626,
  "36-server-switch-pending-checkpoint.spec.ts": 5.732,
  "37-server-rail-pdd.spec.ts": 21.594,
  "38-community-navigation-checkpoint-matrix.spec.ts": 4.646,
  "39-mobile-composer-send.spec.ts": 16.534,
  "39-mobile-message-interactions.spec.ts": 58.479,
  "40-mobile-server-header-hierarchy.spec.ts": 14.449,
  "40-server-rail-unread.spec.ts": 11.954,
  "41-account-unread-projection.spec.ts": 28.753,
  "41-community-initial-load-module-skeletons.spec.ts": 29.632,
  "42-versioned-avatar-identity.spec.ts": 13.96,
  "43-composer-attachment-drafts.spec.ts": 12.139,
  "44-mobile-reaction-details.spec.ts": 32.952,
  "45-desktop-thread-split-view.spec.ts": 11.647,
  "46-community-loading-geometry-android.spec.ts": 49.779,
  "46-community-loading-geometry-dark.spec.ts": 63.284,
  "46-community-loading-geometry-light.spec.ts": 63.095,
  "50-daemon-update-notice.spec.ts": 7.656,
  "51-mobile-forum-tag-editor.spec.ts": 26.043,
  "51-share-image-assets.spec.ts": 46.186,
  "52-chat-composer-ordered-list.spec.ts": 16.531,
  "53-mobile-inbox-surface.spec.ts": 8.362,
  "54-authenticated-context-menu-policy.spec.ts": 13.721,
  "54-blog-multizone.spec.ts": 5.485,
  "55-message-scroll-characterization.spec.ts": 109.548,
  "56-inbox-friend-requests.spec.ts": 60,
  "56-remote-image-state-contract.spec.ts": 3.122,
  "57-server-delete-navigation-races.spec.ts": 55,
  "58-system-notifications.spec.ts": 46.600,
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

function weightedSpecs(specs, weights, defaultSeconds, budgetSeconds) {
  const uniqueSpecs = [...new Set(specs)]
  if (uniqueSpecs.length !== specs.length) {
    throw new Error("spec paths must be unique")
  }
  if (uniqueSpecs.length === 0) {
    throw new Error("at least one spec is required")
  }
  if (uniqueSpecs.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new Error("spec paths must be non-empty strings")
  }
  if (!Number.isInteger(budgetSeconds) || budgetSeconds < 1) {
    throw new Error("budgetSeconds must be a positive integer")
  }
  if (!Number.isFinite(defaultSeconds) || defaultSeconds <= 0) {
    throw new Error("defaultSeconds must be a positive finite number")
  }

  return uniqueSpecs
    .map((path) => ({
      path,
      seconds: Object.hasOwn(weights, path) ? weights[path] : defaultSeconds,
    }))
    .map((spec) => {
      if (!Number.isFinite(spec.seconds) || spec.seconds <= 0) {
        throw new Error(`spec estimate must be a positive finite number: ${spec.path}`)
      }
      if (spec.seconds > budgetSeconds) {
        throw new Error(
          `spec estimate exceeds the ${budgetSeconds}s Playwright budget: ${spec.path} (${spec.seconds}s); split the spec or add a stable case manifest`,
        )
      }
      return spec
    })
    .sort((left, right) => right.seconds - left.seconds || left.path.localeCompare(right.path))
}

function roundedSeconds(value) {
  return Math.round(value * 1_000) / 1_000
}

function packE2eShards(weighted, shardCount, fixedSetupSeconds, safetyMarginSeconds) {
  const shards = Array.from({ length: shardCount }, (_, index) => ({
    shard: index + 1,
    spec_seconds: 0,
    fixed_setup_seconds: fixedSetupSeconds,
    safety_margin_seconds: safetyMarginSeconds,
    predicted_seconds: roundedSeconds(fixedSetupSeconds + safetyMarginSeconds),
    files: [],
  }))

  for (const spec of weighted) {
    const target = [...shards].sort(
      (left, right) => left.spec_seconds - right.spec_seconds || left.shard - right.shard,
    )[0]
    target.files.push(spec.path)
    target.spec_seconds = roundedSeconds(target.spec_seconds + spec.seconds)
    target.predicted_seconds = roundedSeconds(
      target.spec_seconds + fixedSetupSeconds + safetyMarginSeconds,
    )
  }

  return shards.map((shard) => ({
    ...shard,
    files: shard.files.sort(),
  }))
}

export function planE2eShards(specs, options = {}) {
  const {
    weights = SPEC_SECONDS,
    defaultSeconds = DEFAULT_SPEC_SECONDS,
    budgetSeconds = E2E_SHARD_BUDGET_SECONDS,
    fixedSetupSeconds = E2E_FIXED_SETUP_SECONDS,
    safetyMarginSeconds = E2E_SAFETY_MARGIN_SECONDS,
  } = options
  if (!Number.isFinite(fixedSetupSeconds) || fixedSetupSeconds < 0) {
    throw new Error("fixedSetupSeconds must be a non-negative finite number")
  }
  if (!Number.isFinite(safetyMarginSeconds) || safetyMarginSeconds < 0) {
    throw new Error("safetyMarginSeconds must be a non-negative finite number")
  }
  const specBudgetSeconds = budgetSeconds - fixedSetupSeconds - safetyMarginSeconds
  if (!Number.isFinite(specBudgetSeconds) || specBudgetSeconds <= 0) {
    throw new Error("fixed setup and safety margin must leave a positive spec budget")
  }
  const weighted = weightedSpecs(specs, weights, defaultSeconds, specBudgetSeconds)
  const totalSeconds = weighted.reduce((total, spec) => total + spec.seconds, 0)
  let shardCount = Math.ceil(totalSeconds / specBudgetSeconds)
  let shards = packE2eShards(weighted, shardCount, fixedSetupSeconds, safetyMarginSeconds)

  while (shards.some((shard) => shard.spec_seconds > specBudgetSeconds)) {
    shardCount += 1
    shards = packE2eShards(weighted, shardCount, fixedSetupSeconds, safetyMarginSeconds)
  }
  return shards
}

export function createE2eMatrix(specs = discoverE2eSpecs(), image = resolvePlaywrightImage()) {
  const inventory = discoverE2eSpecs()
  if (specs.includes("all") && !(specs.length === 1 && specs[0] === "all")) {
    throw new Error("the all sentinel cannot be combined with explicit specs")
  }
  const selected = specs.length === 1 && specs[0] === "all" ? inventory : specs
  const unknown = selected.filter((spec) => !inventory.includes(spec))
  if (unknown.length > 0) {
    throw new Error(`specs are outside the UI inventory: ${unknown.join(", ")}`)
  }
  const shards = planE2eShards(selected)
  return {
    include: shards.map((shard) => ({
      shard: shard.shard,
      total: shards.length,
      image,
      spec_seconds: shard.spec_seconds,
      fixed_setup_seconds: shard.fixed_setup_seconds,
      safety_margin_seconds: shard.safety_margin_seconds,
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
    .map((shard) => `| ${shard.shard}/${shard.total} | ${shard.spec_seconds}s | ${shard.fixed_setup_seconds}s | ${shard.safety_margin_seconds}s | ${shard.predicted_seconds}s | \`${shard.specs.join(" ")}\` |`)
    .join("\n")
  appendFileSync(
    path,
    `## UI E2E shards\n\nPredicted Playwright command step; ${E2E_SHARD_BUDGET_SECONDS}s budget per shard. Each total includes measured spec time, fixed service setup, and an explicit safety margin.\n\n| Shard | Specs | Fixed setup | Margin | Predicted total | Files |\n| --- | ---: | ---: | ---: | ---: | --- |\n${rows}\n`,
  )
}

export function runCli(argv) {
  const args = parseArgs(argv)
  const specs = args.specsJson ? JSON.parse(args.specsJson) : discoverE2eSpecs()
  if (!Array.isArray(specs) || specs.some((spec) => typeof spec !== "string")) {
    throw new Error("--specs-json must be a JSON array of spec paths")
  }
  const matrix = createE2eMatrix(specs)
  const json = JSON.stringify(matrix)
  if (args.output) appendFileSync(args.output, `e2e_matrix=${json}\n`)
  if (args.summary) writeSummary(args.summary, matrix)
  if (!args.output) process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
}

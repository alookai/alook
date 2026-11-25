import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const FORBIDDEN_BINDINGS = [
  "WORKER_SELF_REFERENCE",
  "NEXT_INC_CACHE_R2_BUCKET",
  "NEXT_TAG_CACHE_D1",
  "NEXT_CACHE_DO_QUEUE",
  "BLOG_WORKER",
]

const WORKER_FIRST_ROUTES = [
  "/blog",
  "/blog/introducing-alook",
  "/blog/ai-team-vs-ai-tools",
  "/blog/feed.xml",
  "/tutorials",
  "/tutorials/codex-and-claude-code",
  "/usecases",
  "/usecases/ask-teammates-seo-bot",
  "/guides",
  "/og/blog/ai-agent-identity",
  "/internal/blog-discovery",
] as const

const STATIC_ASSET_BYPASS_PATHS = [
  "/blog-static/_next/static/chunks/app.js",
  "/_next/static/chunks/app.js",
  "/blog/_generated/hash-480.webp",
  "/blog/introducing-alook/hero.webp",
  "/usecases/ask-teammates-seo-bot/hero.webp",
  "/fonts/dm-sans-600.ttf",
  "/alook.svg",
  "/favicon.ico",
] as const

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${escaped}$`)
}

export function parseRunWorkerFirstRules(wranglerToml: string): string[] | null {
  const match = wranglerToml.match(/^run_worker_first\s*=\s*\[([\s\S]*?)\]/m)
  if (!match) return null
  const body = match[1].replace(/#[^\n]*/g, "")
  return [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
}

export function matchesWorkerFirst(rules: readonly string[], pathname: string): boolean {
  for (const rule of rules) {
    if (rule.startsWith("!") && globToRegExp(rule.slice(1)).test(pathname)) {
      return false
    }
  }
  return rules.some((rule) => !rule.startsWith("!") && globToRegExp(rule).test(pathname))
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
}

export function parseWranglerBindings(output: string): string[] {
  const plain = stripAnsi(output)
  const marker = "Your Worker has access to the following bindings:"
  const inventory = plain.slice(plain.indexOf(marker) + marker.length)
  return [...inventory.matchAll(/^env\.([A-Z0-9_]+)\s+/gm)].map((match) => match[1])
}

export function verifyBlogDryRunEvidence(args: {
  output: string
  outdir: string
  openNextDir: string
  wranglerToml: string
}): void {
  const output = stripAnsi(args.output)
  if (!output.includes("--dry-run: exiting now.")) {
    throw new Error("Wrangler did not complete a dry-run")
  }
  expectExactBindings(parseWranglerBindings(output))
  const runWorkerFirstRules = parseRunWorkerFirstRules(args.wranglerToml)
  if (!runWorkerFirstRules || !runWorkerFirstRules.includes("/*") || !runWorkerFirstRules.some((rule) => rule.startsWith("!/"))) {
    throw new Error("Blog assets must configure narrowed run_worker_first rules with static asset exclusions")
  }
  for (const route of WORKER_FIRST_ROUTES) {
    if (!matchesWorkerFirst(runWorkerFirstRules, route)) {
      throw new Error(`Blog Worker must run first for ${route}`)
    }
  }
  for (const assetPath of STATIC_ASSET_BYPASS_PATHS) {
    if (matchesWorkerFirst(runWorkerFirstRules, assetPath)) {
      throw new Error(`Blog static asset must bypass Worker to apply _headers: ${assetPath}`)
    }
  }
  if (!/^html_handling\s*=\s*"none"\s*$/m.test(args.wranglerToml)) {
    throw new Error("Blog assets must disable HTML redirects so OpenNext owns /blog routes")
  }
  if (!/^not_found_handling\s*=\s*"none"\s*$/m.test(args.wranglerToml)) {
    throw new Error('Blog assets must set not_found_handling = "none" alongside run_worker_first')
  }

  for (const name of FORBIDDEN_BINDINGS) {
    if (output.includes(`env.${name}`) || args.wranglerToml.includes(`binding = "${name}"`)) {
      throw new Error(`Blog Worker must not declare ${name}`)
    }
  }
  if (/config(?:uration)? validation error/i.test(output)) {
    throw new Error("Wrangler reported a configuration validation error")
  }
  if (!existsSync(join(args.outdir, "custom-worker.js"))) {
    throw new Error("Wrangler dry-run did not emit the Blog Worker bundle")
  }

  const serverFunctions = readdirSync(join(args.openNextDir, "server-functions"))
  if (serverFunctions.length !== 1 || serverFunctions[0] !== "default") {
    throw new Error(`Unexpected Blog server functions: ${serverFunctions.join(", ")}`)
  }
  for (const forbidden of ["revalidation-function", "tag-cache", "cache-purge"]) {
    if (serverFunctions.some((entry) => entry.includes(forbidden))) {
      throw new Error(`Blog OpenNext output contains ${forbidden}`)
    }
  }
}

function expectExactBindings(bindings: string[]): void {
  if (bindings.length !== 1 || bindings[0] !== "ASSETS") {
    throw new Error(`Expected ASSETS as the only Blog binding, received: ${bindings.join(", ")}`)
  }
}

export function verifyBlogDryRun(webRoot: string): void {
  const packageManagerCli = process.env.npm_execpath
  if (!packageManagerCli) throw new Error("npm_execpath is required")

  const openNextDir = resolve(webRoot, "blog/.open-next")
  if (!existsSync(join(openNextDir, "worker.js"))) {
    throw new Error("Run pnpm build:blog before verify:blog-dry-run")
  }

  const outdir = mkdtempSync(join(tmpdir(), "alook-blog-dry-run-"))
  try {
    const output = execFileSync(
      packageManagerCli,
      ["exec", "wrangler", "deploy", "--dry-run", "--config", "blog/wrangler.toml", "--outdir", outdir],
      { cwd: webRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
    verifyBlogDryRunEvidence({
      output,
      outdir,
      openNextDir,
      wranglerToml: readFileSync(join(webRoot, "blog/wrangler.toml"), "utf8"),
    })
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  verifyBlogDryRun(resolve(import.meta.dirname, ".."))
  console.log("Verified Blog Wrangler dry-run: ASSETS is the only binding.")
}

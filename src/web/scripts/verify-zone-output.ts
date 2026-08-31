import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type AppPathsManifest = Record<string, string>
type RoutesManifest = {
  redirects: Array<{ source: string; destination: string }>
  rewrites: { beforeFiles: Array<{ source: string; destination: string }> }
}
type PrerenderManifest = { routes: Record<string, unknown> }

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function verifyZoneManifests(args: {
  mainAppPaths: AppPathsManifest
  mainRoutes: RoutesManifest
  blogAppPaths: AppPathsManifest
  blogRoutes: RoutesManifest
  blogPrerender: PrerenderManifest
  postSlugs: string[]
}): void {
  const mainRoutes = Object.keys(args.mainAppPaths)
  assert(
    mainRoutes.every((route) => !route.startsWith("/blog") && !route.startsWith("/og/blog")),
    "Main Next output still owns a Blog route",
  )
  assert(
    args.mainRoutes.redirects.every(({ source, destination }) => (
      !source.startsWith("/blog") && !destination.startsWith("/blog")
    )),
    "Main Next output still owns a Blog redirect",
  )

  const blogRoutes = Object.keys(args.blogAppPaths)
  for (const required of [
    "/blog/(index)/page",
    "/blog/[slug]/page",
    "/blog/feed.xml/route",
    "/og/blog/[slug]/route",
    "/internal/blog-discovery/route",
  ]) {
    assert(blogRoutes.includes(required), `Blog Next output is missing ${required}`)
  }
  assert(
    blogRoutes.every((route) => (
      route.startsWith("/blog") ||
      route.startsWith("/og/blog") ||
      route.startsWith("/internal/blog-discovery") ||
      route.startsWith("/_")
    )),
    "Blog Next output contains a main-owned route",
  )
  assert(
    args.blogRoutes.rewrites.beforeFiles.some(({ source, destination }) => (
      source === "/blog-static/_next/:path+" && destination === "/_next/:path+"
    )),
    "Blog asset-prefix rewrite is missing",
  )

  const prerendered = new Set(Object.keys(args.blogPrerender.routes))
  for (const slug of args.postSlugs) {
    assert(prerendered.has(`/blog/${slug}`), `Blog output is missing published post ${slug}`)
  }
}

function assertIngressAbsent(paths: string[]): void {
  for (const path of paths) {
    if (!existsSync(path)) continue
    const contents = readFileSync(path, "utf8")
    assert(!contents.includes("dev-zone-ingress"), `Production artifact bundles dev ingress: ${path}`)
  }
}

export function verifyZoneOutput(webRoot: string): void {
  const mainNext = join(webRoot, ".next")
  const blogNext = join(webRoot, "blog/.next")
  const blogOpenNext = join(webRoot, "blog/.open-next")
  for (const path of [mainNext, blogNext, blogOpenNext]) {
    assert(existsSync(path), `Required build output is missing: ${path}`)
  }

  const postSlugs = readdirSync(join(webRoot, "blog/src/content"))
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => basename(file, ".mdx"))

  verifyZoneManifests({
    mainAppPaths: readJson(join(mainNext, "server/app-paths-manifest.json")),
    mainRoutes: readJson(join(mainNext, "routes-manifest.json")),
    blogAppPaths: readJson(join(blogNext, "server/app-paths-manifest.json")),
    blogRoutes: readJson(join(blogNext, "routes-manifest.json")),
    blogPrerender: readJson(join(blogNext, "prerender-manifest.json")),
    postSlugs,
  })

  assert(!existsSync(join(webRoot, "public/blog")), "Main public tree still contains Blog assets")
  assert(!existsSync(join(mainNext, "server/app/blog")), "Main server bundle still contains Blog")
  assert(existsSync(join(blogOpenNext, "assets/_next/static")), "Blog static chunks are missing")
  assert(existsSync(join(blogOpenNext, "assets/blog")), "Blog post assets are missing")
  for (const asset of ["alook.svg", "apple-touch-icon.png", "favicon.ico", "icon-192.png", "fonts/dm-sans-600.ttf"]) {
    assert(existsSync(join(blogOpenNext, "assets", asset)), `Staged Blog asset is missing: ${asset}`)
  }

  assertIngressAbsent([
    join(webRoot, ".open-next/worker.js"),
    join(webRoot, "blog/.open-next/worker.js"),
    resolve(webRoot, "../app/bundled/web/.open-next/worker.js"),
  ])
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  verifyZoneOutput(resolve(import.meta.dirname, ".."))
  console.log("Verified independent main and Blog production outputs.")
}

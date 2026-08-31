import { describe, expect, it } from "vitest"
import { verifyZoneManifests } from "./verify-zone-output"

const mainRoutes = {
  redirects: [],
  rewrites: { beforeFiles: [] },
}
const blogRoutes = {
  redirects: [{ source: "/blog/old", destination: "/blog/new" }],
  rewrites: {
    beforeFiles: [{ source: "/blog-static/_next/:path+", destination: "/_next/:path+" }],
  },
}
const blogAppPaths = {
  "/_not-found/page": "not-found.js",
  "/blog/(index)/page": "index.js",
  "/blog/[slug]/page": "post.js",
  "/blog/feed.xml/route": "feed.js",
  "/og/blog/[slug]/route": "og.js",
  "/internal/blog-discovery/route": "manifest.js",
}

describe("zone output verifier", () => {
  it("accepts disjoint main and Blog route inventories", () => {
    expect(() => verifyZoneManifests({
      mainAppPaths: { "/(home)/page": "home.js", "/api/health/route": "health.js" },
      mainRoutes,
      blogAppPaths,
      blogRoutes,
      blogPrerender: { routes: { "/blog/post-one": {} } },
      postSlugs: ["post-one"],
    })).not.toThrow()
  })

  it("rejects Blog ownership in the main output", () => {
    expect(() => verifyZoneManifests({
      mainAppPaths: { "/blog/page": "blog.js" },
      mainRoutes,
      blogAppPaths,
      blogRoutes,
      blogPrerender: { routes: { "/blog/post-one": {} } },
      postSlugs: ["post-one"],
    })).toThrow("Main Next output still owns a Blog route")
  })

  it("rejects main-owned routes in the Blog output", () => {
    expect(() => verifyZoneManifests({
      mainAppPaths: { "/(home)/page": "home.js" },
      mainRoutes,
      blogAppPaths: { ...blogAppPaths, "/api/health/route": "health.js" },
      blogRoutes,
      blogPrerender: { routes: { "/blog/post-one": {} } },
      postSlugs: ["post-one"],
    })).toThrow("Blog Next output contains a main-owned route")
  })
})

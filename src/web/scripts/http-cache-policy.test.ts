import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { getImageProps } from "next/image"

vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }))

import config from "../next.config"

const root = path.resolve(import.meta.dirname, "..")

function matchingPolicies(filename: string, pathname: string): string[] {
  let matches = false
  const policies: string[] = []
  for (const line of readFileSync(path.join(root, filename), "utf8").split("\n")) {
    if (line.startsWith("/")) {
      const pattern = line.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", ".*")
      matches = new RegExp(`^${pattern}$`).test(pathname)
    } else if (matches && line.trim().startsWith("Cache-Control:")) {
      policies.push(line.trim().slice("Cache-Control:".length).trim())
    }
  }
  return policies
}

describe("HTTP cache configuration", () => {
  it.each([
    ["public/_headers", "/_next/static/chunks/content-hash.js"],
    ["public/_headers", "/_next/static/css/content-hash.css"],
    ["public/_headers", "/_next/static/media/content-hash.webp"],
    ["blog/public/_headers", "/_next/static/chunks/content-hash.js"],
    ["blog/public/_headers", "/blog-static/_next/static/chunks/content-hash.js"],
  ])("has a single immutable policy for %s %s", (filename, pathname) => {
    expect(matchingPolicies(filename, pathname)).toEqual(["public, max-age=31536000, immutable"])
  })

  it.each([
    ["public/_headers", "/landing/people/lin.webp"],
    ["public/_headers", "/alook.svg"],
    ["blog/public/_headers", "/blog/article/hero.webp"],
    ["blog/public/_headers", "/alook.svg"],
  ])("keeps non-versioned images on a short policy: %s %s", (filename, pathname) => {
    expect(matchingPolicies(filename, pathname)).toEqual(["public, max-age=300, must-revalidate"])
  })

  it.each(["/c", "/c/me", "/c/channels/server/channel", "/c/invite/token", "/api/community/users/me/profile"])("does not declare a static public document policy for %s", (pathname) => {
    expect(matchingPolicies("public/_headers", pathname)).toEqual([])
  })

  it("renders Main raster images directly without the unconfigured optimization endpoint", () => {
    const { props } = getImageProps({
      src: "/landing/people/lin.webp",
      alt: "",
      width: 58,
      height: 58,
      unoptimized: config.images?.unoptimized,
    })
    expect(config.images?.unoptimized).toBe(true)
    expect(props.src).toBe("/landing/people/lin.webp")
    expect(props.srcSet).toBeUndefined()
  })
})

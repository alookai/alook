import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, extname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

function productionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (![".ts", ".tsx"].includes(extname(entry.name))) return []
    if (entry.name.includes(".test.")) return []
    return [path]
  })
}

function importedSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*(?:\(|\s))["']([^"']+)["']/g)]
    .map((match) => match[1])
}

function resolvedSourceImport(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return join(SRC_ROOT, specifier.slice(2))
  if (specifier.startsWith(".")) return resolve(dirname(from), specifier)
  return null
}

describe("Web client architecture boundaries", () => {
  it("keeps platform client independent of product modules", () => {
    const forbidden = productionSources(join(SRC_ROOT, "platform/client"))
      .flatMap((path) => importedSpecifiers(readFileSync(path, "utf8"))
        .map((specifier) => ({ specifier, target: resolvedSourceImport(path, specifier) }))
        .filter(({ target }) => target !== null && [
          join(SRC_ROOT, "modules"),
          join(SRC_ROOT, "lib/community"),
          join(SRC_ROOT, "components/community"),
          join(SRC_ROOT, "hooks/community"),
          join(SRC_ROOT, "stores/community"),
        ].some((root) => target === root || target.startsWith(`${root}/`)))
        .map(({ specifier }) => ({ path, specifier })))

    expect(forbidden).toEqual([])
  })

  it("keeps Community client independent of server and Cloudflare capabilities", () => {
    const forbidden = productionSources(join(SRC_ROOT, "modules/community/client"))
      .flatMap((path) => importedSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => {
          const target = resolvedSourceImport(path, specifier)
          return (target !== null && [
            join(SRC_ROOT, "platform/server"),
            join(SRC_ROOT, "modules/community/server"),
          ].some((root) => target === root || target.startsWith(`${root}/`)))
            || specifier.startsWith("cloudflare:")
            || specifier.startsWith("@cloudflare/")
            || specifier === "wrangler"
            || specifier === "@opennextjs/cloudflare"
        })
        .map((specifier) => ({ path, specifier })))

    expect(forbidden).toEqual([])
  })

  it("keeps the Community shell on the module public entry", () => {
    const shell = readFileSync(join(SRC_ROOT, "app/c/community-shell.tsx"), "utf8")

    expect(shell).toMatch(/from ["']@\/modules\/community\/client["']/)
    expect(shell).not.toMatch(/@\/modules\/community\/client\//)
  })

  it("keeps lint rules aligned with the source-contract checks", () => {
    const eslintConfig = readFileSync(join(WEB_ROOT, "eslint.config.mjs"), "utf8")

    expect(eslintConfig).toContain('files: ["src/platform/client/**/*.{ts,tsx}"]')
    expect(eslintConfig).toContain('group: ["@/modules/**"')
    expect(eslintConfig).toContain('files: ["src/modules/community/client/**/*.{ts,tsx}"]')
    expect(eslintConfig).toContain('group: ["@/platform/server"')
    expect(eslintConfig).toContain('files: ["src/app/c/community-shell.tsx"]')
    expect(eslintConfig).toContain('group: ["@/modules/community/client/**"]')
  })
})

import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { build, transform } from "esbuild"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const webRoot = path.resolve(import.meta.dirname, "../../..")
const require = createRequire(import.meta.url)
const clientProxy = require.resolve("next/dist/compiled/react-server-dom-turbopack/server.node")

async function runServerSeed(mode: "development" | "production") {
  const directory = await mkdtemp(path.join(tmpdir(), "alook-document-rsc-"))
  const output = path.join(directory, "seed.cjs")
  const clients = new Set<string>()
  try {
    const result = await build({
      absWorkingDir: webRoot,
      stdin: {
        resolveDir: webRoot,
        contents: `
          import assert from "node:assert/strict"
          import { readCommunityDocumentSeed } from "@/lib/community/document-seed.server"
          import { getCommunityRuntime } from "@/stores/community/runtime"
          import { getCommunityRuntime as getOwner } from "@/stores/community/runtime-owner"
          import { createCommunityDbRegistry } from "@/lib/community-db/collections"
          import { QueryClient } from "@tanstack/react-query"
          const profile = { id: "viewer", name: "Viewer", discriminator: "0042", avatar: null, avatarVersion: 0, aboutMe: "", bannerColor: null, statusEmoji: null, statusText: null }
          async function main() {
            assert.throws(() => getCommunityRuntime({}), /getCommunityRuntime.*from the server/)
            for (const [href, kind] of [["/c/me", "me"], ["/c/channels/s1/c1", "text"], ["/c/channels/s1/c1", "forum"], ["/c/me/c1", "dm"], ["/c/channels/s1", "server"], ["/c/me/bots", "bots"], ["/c/me/machines", "machines"]]) {
              const seed = await readCommunityDocumentSeed({ kind }, "viewer", href, profile)
              assert.equal(seed.viewerId, "viewer")
              assert.equal(seed.selfProfile.name, "Viewer")
              assert.deepEqual(seed.db.collections, [])
              assert.ok(seed.db.liveQueries.length >= 3)
              assert.ok(seed.db.liveQueries.some(query => query.snapshot.rows.some(row => row.value.name === "Viewer")))
              if (href.endsWith("/c1")) {
                assert.equal(seed.entries.length, 1, href)
                assert.equal(seed.entries[0].data.channel.type, kind)
                assert.ok(JSON.stringify(seed.db.liveQueries).includes("Body"), href)
              }
              if (href.endsWith("/bots")) assert.deepEqual(seed.bots.bots, [])
              if (href.endsWith("/machines")) assert.deepEqual(seed.machines.machines, [])
              assert.deepEqual(JSON.parse(JSON.stringify(seed)), seed)
            }
            const isolated = await Promise.all(["alice", "bob"].map(id => readCommunityDocumentSeed({}, id, "/c/me", { ...profile, id, name: id })))
            for (const [index, seed] of isolated.entries()) {
              const other = isolated[1 - index].viewerId
              assert.ok(!seed.db.liveQueries.some(query => query.snapshot.rows.some(row => row.value.id === other)))
            }
            const client = new QueryClient()
            const registry = createCommunityDbRegistry(client, "viewer")
            try {
              assert.equal(getOwner(client), registry.runtime)
              assert.throws(() => getOwner(new QueryClient()), error => error.name === "AbortError")
            } finally { await registry.cleanup(); client.clear() }
            assert.throws(() => getOwner(client), error => error.name === "AbortError")
            process.stdout.write("server-seed-ok")
          }
          main().catch(error => { console.error(error); process.exitCode = 1 })
        `,
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      treeShaking: true,
      external: ["react", clientProxy],
      logLevel: "silent",
      plugins: [{
        name: "rsc-client-boundary",
        setup(builder) {
          builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path: filename }) => {
            const source = await readFile(filename, "utf8")
            const directives = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true).statements
            let client = false
            for (const statement of directives) {
              if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
              if (statement.expression.text === "use client") client = true
            }
            if (client) {
              clients.add(filename)
              const compiled = await transform(source, { loader: filename.endsWith(".tsx") ? "tsx" : filename.endsWith(".ts") ? "ts" : "js", format: "esm" })
              const parsed = ts.createSourceFile(filename, compiled.code, ts.ScriptTarget.Latest, true)
              const names = parsed.statements.flatMap(statement => ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map(element => element.name.text) : [])
              return { contents: `import { createClientModuleProxy } from ${JSON.stringify(clientProxy)}; const proxy = createClientModuleProxy(${JSON.stringify(filename)}); ${names.map(name => name === "default" ? "export default proxy.default;" : `export const ${name} = proxy[${JSON.stringify(name)}];`).join("\n")}`, loader: "js" }
            }
            if (filename.endsWith("/community/message-door.ts")) return { contents: "export async function resolveMessageTarget(db, viewer, target) { return { ok: true, value: { access: { channel: { serverId: db.kind === 'dm' ? null : 's1' } } } } }", loader: "js" }
            if (filename.endsWith("/community/conversation-entry.server.ts")) return {
              contents: `import { conversationEntryFixture, dmConversationEntryFixture, forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"; export async function readCommunityConversationEntry(db) { return { ok: true, entry: db.kind === "dm" ? dmConversationEntryFixture() : db.kind === "forum" ? forumConversationEntryFixture() : conversationEntryFixture() } }`, loader: "js",
            }
            if (filename.endsWith("/community/bots.server.ts")) return { contents: "export async function readCommunityBots() { return { bots: [], plan: { id: 'free', displayName: 'Free' }, isFounder: false, limit: 1, ownedCount: 0, activeCount: 0 } }", loader: "js" }
            if (filename.endsWith("/community/machines.server.ts")) return { contents: "export async function readCommunityMachineList() { return { machines: [] } }", loader: "js" }
            if (filename.endsWith("/community/server-directory.server.ts")) return { contents: "export async function readCommunityServerDirectory() { return { id: 's1', name: 'Server', discriminator: '0042', description: '', ownerId: 'viewer', icon: null, categories: [] } }", loader: "js" }
          })
        },
      }],
    })
    await writeFile(output, result.outputFiles[0].contents)
    const stdout = execFileSync(process.execPath, ["--conditions=react-server", output], {
      cwd: webRoot,
      env: { ...process.env, NODE_ENV: mode, NODE_PATH: path.join(webRoot, "node_modules") },
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { stdout, clients }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("document seed with native Next client references", () => {
  it.each(["development", "production"] as const)("executes the server installer with %s client references and preserves its boundary", async mode => {
    const result = await runServerSeed(mode)
    expect(result.stdout).toBe("server-seed-ok")
    expect(result.clients.has(path.join(webRoot, "src/stores/community/runtime.tsx"))).toBe(true)
  })
})

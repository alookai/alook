import { PassThrough } from "node:stream"
import { createElement, type ReactNode } from "react"
import { renderToPipeableStream } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CurrentUser } from "@/contexts/community/current-user"

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  cloudflareContext: vi.fn(),
  headers: vi.fn(),
  pathname: "/c",
  documentHref: "/c/channels/server-a/channel-a",
  db: vi.fn(),
  primaryDb: vi.fn(),
  d1: { withSession: vi.fn() },
  bots: vi.fn(),
  machines: vi.fn(),
  client: vi.fn(),
  self: vi.fn(),
  seed: vi.fn(),
}))

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mocks.cloudflareContext }))
vi.mock("@/lib/db", async original => {
  const actual = await original<typeof import("@/lib/db")>()
  mocks.db.mockImplementation(actual.getDb)
  mocks.primaryDb.mockImplementation(actual.getPrimaryDb)
  return { ...actual, getDb: mocks.db, getPrimaryDb: mocks.primaryDb }
})
vi.mock("@/lib/community/bots.server", () => ({ readCommunityBots: mocks.bots }))
vi.mock("@/lib/community/machines.server", () => ({ readCommunityMachineList: mocks.machines }))
vi.mock("next/headers", () => ({ headers: mocks.headers }))
vi.mock("@/lib/community/self-profile.server", () => ({ readCommunitySelfProfile: mocks.self }))
vi.mock("@/lib/community/document-seed.server", () => ({ readCommunityDocumentSeed: mocks.seed }))
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }))
vi.mock("@/components/community/billing/billing-plan.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("./community-layout-client", () => ({
  CommunityLayoutClient: (props: {
    currentUser: CurrentUser | null
    children: ReactNode
    sidebar: ReactNode
  }) => {
    mocks.client(props)
    return createElement("section", { "data-testid": "resolved-session" },
      props.currentUser?.id ?? "anonymous", props.sidebar, props.children)
  },
}))

import CommunityLayout from "./layout"

const children = createElement("main", { "data-testid": "private-child" }, "private content")
const sidebar = createElement("aside", { "data-testid": "private-sidebar" }, "private sidebar")
const session = {
  user: { id: "account-a", name: "Ada", email: "ada@example.com", image: "avatar-a" },
}
const profile = { id: "account-a", name: "Canonical Ada", discriminator: "0042", avatar: "canonical-avatar", avatarVersion: 9, aboutMe: "About Ada", bannerColor: null, statusEmoji: null, statusText: "" }
const seed = { viewerId: "account-a", selfProfile: profile, entries: [], db: { collections: [] } }
const currentUser = { ...profile, email: "ada@example.com" }

function renderLayout() {
  const output = new PassThrough()
  const errors: unknown[] = []
  let html = ""
  let resolvePublicFrame!: (html: string) => void
  const publicFrame = new Promise<string>((resolve) => { resolvePublicFrame = resolve })
  const finished = new Promise<string>((resolve, reject) => {
    output.on("data", (chunk: Buffer) => {
      html += chunk.toString()
      if (html.includes("<!--/$-->")) resolvePublicFrame(html)
    })
    output.on("end", () => resolve(html))
    output.on("error", reject)
  })
  const rendering = renderToPipeableStream(createElement("html", null,
    // React supplies children from the third argument; its props overload requires that injected field.
    createElement("body", null, createElement(CommunityLayout, { sidebar } as Parameters<typeof CommunityLayout>[0], children))), {
    onShellReady: () => rendering.pipe(output),
    onShellError: (error) => output.destroy(error instanceof Error ? error : new Error("SSR shell failed", { cause: error })),
    onError: (error) => { errors.push(error) },
  })
  return { publicFrame, finished, errors, abort: rendering.abort }
}

beforeEach(() => {
    mocks.getSession.mockReset()
    mocks.cloudflareContext.mockReset().mockResolvedValue({ env: { DB: mocks.d1 } })
    mocks.headers.mockReset().mockImplementation(async () => new Headers({ "x-alook-community-document-route": mocks.documentHref }))
    mocks.client.mockClear()
    mocks.pathname = "/c"
    mocks.documentHref = "/c/channels/server-a/channel-a"
    mocks.db.mockClear(); mocks.primaryDb.mockClear()
    mocks.d1.withSession.mockReset().mockImplementation((constraint: string) => ({ constraint, prepare: vi.fn(), batch: vi.fn() }))
    mocks.bots.mockReset().mockResolvedValue({ bots: [], plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 0, activeCount: 0 })
    mocks.machines.mockReset().mockResolvedValue({ machines: [] })
    mocks.self.mockReset().mockResolvedValue({ viewer: { ...session.user, image: "canonical-avatar", avatarVersion: 9 }, profile })
    mocks.seed.mockReset().mockResolvedValue(seed)
  })

describe("CommunityLayout server session streaming", () => {
  it("uses the same primary D1 session as the machines HTTP list", async () => {
    mocks.documentHref = "/c/me/machines"
    mocks.getSession.mockResolvedValue(session)
    await renderLayout().finished
    expect(mocks.primaryDb).toHaveBeenCalledOnce()
    expect(mocks.db).not.toHaveBeenCalled()
  })

  it.each([
    ["/c", "community-root-redirect", "route-resolution"],
    ["/c/channels/server-a/channel-a", "server-detail", "server-conversation"],
    ["/c/invite/token", "public-invite", null],
    ["/c/invite/token/extra", "unknown", "route-resolution"],
  ])("streams a public frame for %s while the session is held", async (pathname, route, main) => {
    mocks.pathname = pathname
    let release!: (value: typeof session) => void
    mocks.getSession.mockReturnValue(new Promise<typeof session>((resolve) => { release = resolve }))
    const rendering = renderLayout()
    try {
      const first = await rendering.publicFrame
      expect(first).toContain('data-testid="community-initial-frame"')
      expect(first).toContain(`data-community-route-kind="${route}"`)
      if (main) expect(first).toContain(`data-testid="community-pending-main-${main}"`)
      expect(first).not.toContain("private-child")
      expect(first).not.toContain("private-sidebar")
      expect(first).not.toContain("resolved-session")
      expect(first).not.toContain("account-a")
      expect(first).not.toContain("ada@example.com")
      expect(first).not.toContain("community-user-bar-name")
      expect(mocks.client).not.toHaveBeenCalled()
      expect(mocks.getSession).toHaveBeenCalledTimes(1)
      release(session)
      const complete = await rendering.finished
      expect(complete).toContain("resolved-session")
      expect(complete).toContain("private-child")
      expect(complete).toContain("private-sidebar")
      expect(mocks.client).toHaveBeenCalledTimes(1)
      expect(mocks.client).toHaveBeenCalledWith({
        currentUser,
        initialSeed: seed,
        children,
        sidebar,
      })
      expect(rendering.errors).toEqual([])
    } finally {
      rendering.abort()
    }
  })

  it.each([
    ["avatar-a", "avatar-a"],
    ["", "A"],
    [null, "A"],
  ])("uses the canonical profile even when the session image is %s", async (image, _expectedAvatar) => {
    mocks.getSession.mockResolvedValue({ user: { ...session.user, image } })
    const rendering = renderLayout()
    await rendering.finished
    expect(mocks.client).toHaveBeenCalledWith({
      currentUser,
      initialSeed: seed,
      children,
      sidebar,
    })
    expect(rendering.errors).toEqual([])
  })

  it("passes only a resolved null session to the original anonymous owner", async () => {
    mocks.getSession.mockResolvedValue(null)
    const rendering = renderLayout()
    await rendering.finished
    expect(mocks.client).toHaveBeenCalledWith({ currentUser: null, initialSeed: undefined, children, sidebar })
    expect(rendering.errors).toEqual([])
  })

  it("keeps streaming the public skeleton while authenticated document data is held", async () => {
    mocks.getSession.mockResolvedValue(session)
    let release!: (value: typeof seed) => void
    mocks.seed.mockReturnValue(new Promise(resolve => { release = resolve }))
    const rendering = renderLayout()
    try {
      const first = await rendering.publicFrame
      expect(first).toContain("community-initial-frame")
      expect(first).not.toContain("Canonical Ada")
      expect(first).not.toContain("private-child")
      expect(mocks.client).not.toHaveBeenCalled()
      release(seed)
      await rendering.finished
      expect(mocks.client).toHaveBeenCalledWith(expect.objectContaining({ currentUser, initialSeed: seed }))
      expect(rendering.errors).toEqual([])
    } finally { rendering.abort() }
  })

  it("does not serialize private data when the canonical user row is missing", async () => {
    mocks.getSession.mockResolvedValue(session)
    mocks.self.mockResolvedValue({ viewer: null, profile })
    const rendering = renderLayout()
    await rendering.finished
    expect(mocks.seed).not.toHaveBeenCalled()
    expect(mocks.client).toHaveBeenCalledWith(expect.objectContaining({ currentUser: null, initialSeed: undefined }))
  })

  it("reports a rejected session without invoking an anonymous client branch", async () => {
    const error = new Error("session unavailable")
    mocks.getSession.mockRejectedValue(error)
    const rendering = renderLayout()
    await rendering.finished
    expect(rendering.errors).toContain(error)
    expect(mocks.client).not.toHaveBeenCalled()
  })
})


describe("Bots document Machine-list primary connection", () => {
  it.each(["/c/me/bots", "/c/me/bots?msg=fixture"])("carries the actual primary wrapper into both existing loaders for %s", async href => {
    mocks.documentHref = href
    mocks.getSession.mockResolvedValue(session)
    const { readCommunityDocumentSeed } = await vi.importActual<typeof import("@/lib/community/document-seed.server")>("@/lib/community/document-seed.server")
    mocks.seed.mockImplementation(readCommunityDocumentSeed)
    const rendering = renderLayout()
    await rendering.finished
    expect(rendering.errors).toEqual([])
    expect(mocks.d1.withSession).toHaveBeenCalledExactlyOnceWith("first-primary")
    expect(mocks.primaryDb).toHaveBeenCalledOnce()
    expect(mocks.db).not.toHaveBeenCalled()
    const selected = mocks.primaryDb.mock.results[0]!.value
    expect(mocks.self).toHaveBeenCalledWith(selected, "account-a")
    expect(mocks.bots).toHaveBeenCalledWith(selected, "account-a")
    expect(mocks.machines).toHaveBeenCalledWith(selected, "account-a")
    expect(mocks.client.mock.calls[0]![0].initialSeed).toMatchObject({ viewerId: "account-a", machines: { machines: [] }, bots: { bots: [] } })
  })
  it("preserves first-unconstrained for an unrelated server document", async () => {
    mocks.documentHref = "/c/channels/server-a/channel-a"
    mocks.getSession.mockResolvedValue(session)
    const rendering = renderLayout()
    await rendering.finished
    expect(rendering.errors).toEqual([])
    expect(mocks.d1.withSession).toHaveBeenCalledExactlyOnceWith("first-unconstrained")
    expect(mocks.db).toHaveBeenCalledOnce()
    expect(mocks.primaryDb).not.toHaveBeenCalled()
    const selected = mocks.db.mock.results[0]!.value
    expect(mocks.self).toHaveBeenCalledWith(selected, "account-a")
    expect(mocks.seed).toHaveBeenCalledWith(selected, "account-a", mocks.documentHref, profile)
  })
})


describe("document session eligibility before profile and seed reads", () => {
  it.each(["/c/me/bots", "/c/channels/server-a/channel-a"].flatMap(href => [
    { href, label: "soft-deleted", isBot: false, deletedAt: "2026-10-01T00:00:00.000Z" },
    { href, label: "bot", isBot: true, deletedAt: null },
    { href, label: "deleted bot", isBot: true, deletedAt: "2026-10-01T00:00:00.000Z" },
    { href, label: "nonnull empty deletion field", isBot: false, deletedAt: "" },
  ]))("rejects $label session on $href before any document read", async ({ href, isBot, deletedAt }) => {
    mocks.documentHref = href
    mocks.getSession.mockResolvedValue({ ...session, user: { ...session.user, isBot, deletedAt } })
    // The profile row remains present: an absent row cannot stand in for these session flags.
    const rendering = renderLayout()
    const html = await rendering.finished
    expect(mocks.getSession).toHaveBeenCalledOnce()
    expect(mocks.cloudflareContext).not.toHaveBeenCalled()
    expect(mocks.headers).not.toHaveBeenCalled()
    expect(mocks.d1.withSession).not.toHaveBeenCalled()
    expect(mocks.db).not.toHaveBeenCalled()
    expect(mocks.primaryDb).not.toHaveBeenCalled()
    expect(mocks.self).not.toHaveBeenCalled()
    expect(mocks.seed).not.toHaveBeenCalled()
    expect(mocks.bots).not.toHaveBeenCalled()
    expect(mocks.machines).not.toHaveBeenCalled()
    expect(mocks.client).toHaveBeenCalledExactlyOnceWith({ currentUser: null, initialSeed: undefined, children, sidebar })
    expect(html).not.toContain("account-a")
    expect(html).not.toContain("Canonical Ada")
    expect(html).not.toContain("ada@example.com")
    expect(rendering.errors).toEqual([])
  })

  it("admits an explicit live human session and keeps its original document reads", async () => {
    mocks.getSession.mockResolvedValue({ ...session, user: { ...session.user, isBot: false, deletedAt: null } })
    const rendering = renderLayout()
    await rendering.finished
    expect(mocks.getSession).toHaveBeenCalledOnce()
    expect(mocks.cloudflareContext).toHaveBeenCalledOnce()
    expect(mocks.self).toHaveBeenCalledOnce()
    expect(mocks.seed).toHaveBeenCalledOnce()
    expect(mocks.client).toHaveBeenCalledExactlyOnceWith({ currentUser, initialSeed: seed, children, sidebar })
    expect(rendering.errors).toEqual([])
  })
})

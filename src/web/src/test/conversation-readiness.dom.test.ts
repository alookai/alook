import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { Page, Request, TestInfo } from "@playwright/test"
import { inspectConversationReadiness, type ConversationInspectionTarget } from "./conversation-readiness"
import { expectConversationReady, observeConversationTransport } from "./e2e-ui/_fixtures/conversation-readiness"
import { mockElementGeometry } from "./react-dom-harness"
import { tid } from "@/lib/community/testids"

let geometryRestorers: Array<() => void>

function size(element: Element, width = 100, height = 40) {
  geometryRestorers.push(mockElementGeometry(element as HTMLElement, { width, height }))
}

function sizeContents(container: Element) {
  for (const element of container.querySelectorAll("*")) size(element)
}

const target: ConversationInspectionTarget = {
  pathname: "/c/channels/server/channel", serverId: "server", channelId: "channel",
  kind: "text", messageTestId: "community-message-expected",
  testIds: { channelSidebarScroll: tid.channelSidebarScroll, composerInput: tid.composerInput, forumPostList: tid.forumPostList, pendingMainPrefix: tid.pendingMain(""), messagePrefix: tid.message("") },
}

function mount() {
  document.body.innerHTML = `
    <div data-community-channel-tree-scope="server:server" style="display:contents">
      <aside><div data-testid="${tid.channelSidebarScroll}"></div></aside>
    </div>
    <main data-slot="community-main-panel-content">
      <div data-slot="community-conversation-surface" data-channel-id="channel">
        <div data-message-list-content data-initial-position-phase="revealed">
          <h2>all</h2><p>Beginning of the channel.</p>
          <div data-testid="community-message-expected">actual target message</div>
        </div>
        <div data-testid="community-composer-input"><div contenteditable="true"></div></div>
      </div>
    </main>`
}

beforeEach(() => {
  vi.stubGlobal("location", { pathname: target.pathname })
  geometryRestorers = []
  mount()
  sizeContents(document.body)
  size(document.querySelector("[data-community-channel-tree-scope]")!, 0, 0)
})
afterEach(() => { for (const restore of geometryRestorers.reverse()) restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = "" })

describe("consumer readiness acceptance", () => {
  it("uses an independently sized sidebar under the zero-box contents owner", () => {
    expect(document.querySelector("[data-community-channel-tree-scope]")!.getBoundingClientRect().width).toBe(0)
    expect(document.querySelector(`[data-testid="${tid.channelSidebarScroll}"]`)!.getBoundingClientRect().width).toBe(100)
    expect(inspectConversationReadiness(target).ready).toBe(true)
  })
  it("rejects a zero-box or missing sidebar even with unrelated visible sidebar content", () => {
    const sidebar = document.querySelector(`[data-testid="${tid.channelSidebarScroll}"]`)!
    size(sidebar, 0, 0)
    expect(inspectConversationReadiness(target).blockers).toContain("wrong-server-scope")
    sidebar.remove()
    document.querySelector("main")!.insertAdjacentHTML("beforeend", `<div data-testid="${tid.channelSidebarScroll}"></div>`)
    size(document.querySelector(`main [data-testid="${tid.channelSidebarScroll}"]`)!)
    expect(inspectConversationReadiness(target).blockers).toContain("wrong-server-scope")
  })
  it("does not borrow a nested foreign scope's visible sidebar", () => {
    const owner = document.querySelector("[data-community-channel-tree-scope]")!
    owner.innerHTML = `<div data-community-channel-tree-scope="server:foreign" style="display:contents"><aside><div data-testid="${tid.channelSidebarScroll}"></div></aside></div>`
    sizeContents(owner)
    size(owner.firstElementChild!, 0, 0)
    expect(inspectConversationReadiness(target).blockers).toContain("wrong-server-scope")
  })
  it("requires the actual owner scope even when its registered sidebar is usable", () => {
    document.querySelector("[data-community-channel-tree-scope]")!.setAttribute("data-community-channel-tree-scope", "server:other")
    expect(inspectConversationReadiness(target).blockers).toContain("wrong-server-scope")
  })
  it.each(["owner", "sidebar"])("rejects hidden, fading, inert and blocked %s state", (part) => {
    const element = document.querySelector(part === "owner" ? "[data-community-channel-tree-scope]" : `[data-testid="${tid.channelSidebarScroll}"]`)!
    for (const style of ["display:none", "visibility:hidden", "opacity:0", "opacity:0.5", "pointer-events:none"]) {
      element.setAttribute("style", `${part === "owner" ? "display:contents;" : ""}${style}`)
      expect(inspectConversationReadiness(target).blockers).toContain("wrong-server-scope")
    }
    element.setAttribute("style", part === "owner" ? "display:contents" : "")
    for (const attribute of ["inert", "aria-disabled"]) {
      element.setAttribute(attribute, attribute === "inert" ? "" : "true")
      expect(inspectConversationReadiness(target).blockers).toContain("wrong-server-scope")
      element.removeAttribute(attribute)
    }
    expect(inspectConversationReadiness(target).ready).toBe(true)
  })
  it("rejects visible busy shells and accepts settled or visually hidden counterparts", () => {
    const shell = document.querySelector("main")!
    shell.setAttribute("data-slot", "community-shell-root")
    shell.setAttribute("aria-busy", "true")
    expect(inspectConversationReadiness(target).blockers).toContain("busy-shell")
    shell.setAttribute("aria-busy", "false")
    expect(inspectConversationReadiness(target).ready).toBe(true)
    const hiddenShell = document.createElement("div")
    hiddenShell.setAttribute("data-slot", "community-shell-root")
    hiddenShell.setAttribute("aria-busy", "true")
    hiddenShell.style.display = "none"
    document.body.append(hiddenShell)
    size(hiddenShell)
    expect(inspectConversationReadiness(target).ready).toBe(true)
  })
  it("rejects unspecified content identity despite usable real content", () => {
    expect(inspectConversationReadiness({ ...target, messageTestId: undefined }).blockers).toContain("content-identity-unspecified")
    expect(inspectConversationReadiness(target).ready).toBe(true)
  })
  it("requires exact route, scope, channel and real message identity", () => {
    expect(inspectConversationReadiness(target).ready).toBe(true)
    expect(inspectConversationReadiness({ ...target, pathname: "/c/channels/server/other" }).blockers).toContain("wrong-route")
    expect(inspectConversationReadiness({ ...target, serverId: "other" }).blockers).toContain("wrong-server-scope")
    expect(inspectConversationReadiness({ ...target, channelId: "other" }).blockers).toContain("wrong-conversation-surface")
    expect(inspectConversationReadiness({ ...target, messageTestId: "community-message-wrong" }).blockers).toContain("expected-message-missing")
  })
  it.each(["positioning", "revealing", "skeleton"])("does not accept real DOM in the %s phase", (phase) => {
    document.querySelector("[data-message-list-content]")!.setAttribute("data-initial-position-phase", phase)
    expect(inspectConversationReadiness(target).blockers).toContain("content-not-revealed")
  })
  it.each(["opacity:0", "opacity:0.5", "visibility:hidden", "display:none", "pointer-events:none"])("rejects ancestor state %s", (style) => {
    document.querySelector("main")!.setAttribute("style", style)
    expect(inspectConversationReadiness(target).ready).toBe(false)
  })
  it("rejects ancestor inert even when the message has visible dimensions", () => {
    document.querySelector("main")!.setAttribute("inert", "")
    expect(inspectConversationReadiness(target).blockers).toContain("content-not-revealed")
  })
  it.each([
    'data-message-positioning-skeleton=""', 'data-message-list-skeleton=""',
    'data-testid="community-pending-main-server-conversation"', 'data-community-unresolved-main=""',
    'data-slot="skeleton"',
  ])("rejects visible mask %s; aria-hidden does not make it visually absent", (attribute) => {
    document.querySelector("main")!.insertAdjacentHTML("beforeend", `<div ${attribute} aria-hidden="true"></div>`)
    size(document.querySelector("main")!.lastElementChild!)
    expect(inspectConversationReadiness(target).blockers).toContain("visible-mask")
    document.querySelector("main")!.lastElementChild!.setAttribute("style", "opacity:0")
    expect(inspectConversationReadiness(target).ready).toBe(true)
  })
  it("needs the actual editable child, not just its composer wrapper", () => {
    document.querySelector("[contenteditable]")!.remove()
    expect(inspectConversationReadiness(target).blockers).toContain("composer-unusable")
  })
  it("only accepts empty content when the hero exists and no actual message remains", () => {
    const empty = { ...target, messageTestId: undefined, empty: true }
    expect(inspectConversationReadiness(empty).blockers).toContain("empty-contract-missing")
    document.querySelector('[data-testid="community-message-expected"]')!.remove()
    expect(inspectConversationReadiness(empty).ready).toBe(true)
    document.querySelector("h2")!.remove()
    expect(inspectConversationReadiness(empty).ready).toBe(false)
  })
  it("requires the exact seeded forum post, not another same-server empty list", () => {
    const forum = { ...target, kind: "forum" as const, messageTestId: undefined, forumPostTestId: "community-forum-thread-card-post" }
    document.querySelector("main")!.innerHTML = '<div data-testid="community-forum-post-list"><div data-slot="skeleton"></div></div>'
    sizeContents(document.querySelector("main")!)
    expect(inspectConversationReadiness(forum).ready).toBe(false)
    document.querySelector("main")!.innerHTML = '<div data-testid="community-forum-post-list">No posts with this tag yet. Start one with New Post.</div>'
    sizeContents(document.querySelector("main")!)
    expect(inspectConversationReadiness(forum).ready).toBe(false)
    document.querySelector("main")!.innerHTML = '<div data-testid="community-forum-post-list"><div data-testid="community-forum-thread-card-post">typed post</div></div>'
    sizeContents(document.querySelector("main")!)
    expect(inspectConversationReadiness(forum).ready).toBe(true)
    expect(inspectConversationReadiness({ ...forum, channelId: "other" }).ready).toBe(false)
    expect(inspectConversationReadiness({ ...forum, forumPostTestId: "community-forum-thread-card-wrong" }).ready).toBe(false)
  })
  it("uses exact DM message identity without a server-tree requirement", () => {
    vi.stubGlobal("location", { pathname: "/c/me/channel" })
    document.querySelector("[data-community-channel-tree-scope]")!.remove()
    expect(inspectConversationReadiness({ ...target, pathname: "/c/me/channel", serverId: undefined, kind: "dm" }).ready).toBe(true)
  })
})

describe("transport outcomes remain separate from consumer readiness", () => {
  function fixture() {
    const events = new EventEmitter()
    const page = events as unknown as Page
    const transport = observeConversationTransport(page)
    const request = {
      url: () => "http://localhost/c/channels/server/channel?_rsc=opaque",
      headers: () => ({ rsc: "1" }), method: () => "GET", failure: () => ({ errorText: "net::ERR_ABORTED" }),
    } as unknown as Request
    return { page, events, transport, request }
  }
  it("records 200 then cancellation as failed, never finished", () => {
    const { events, transport, request } = fixture()
    events.emit("request", request)
    events.emit("response", { request: () => request, status: () => 200, url: request.url })
    events.emit("requestfailed", request)
    expect(transport.targetRsc("server", 0)).toMatchObject([{ status: 200, terminal: "failed", failure: "net::ERR_ABORTED", prefetch: false }])
    expect(transport.snapshot().requests[0].terminal).not.toBe("finished")
    transport.stop()
  })
  it("cancellation without target readiness still fails the bounded gate", async () => {
    const { events, transport, request, page } = fixture()
    events.emit("request", request)
    events.emit("response", { request: () => request, status: () => 200, url: request.url })
    events.emit("requestfailed", request)
    document.querySelector('[data-testid="community-message-expected"]')!.remove()
    page.evaluate = vi.fn(async () => inspectConversationReadiness(target)) as unknown as Page["evaluate"]
    const info = { attach: vi.fn(async () => {}) } as unknown as TestInfo
    await expect(expectConversationReady(page, target, info, 30)).rejects.toThrow("Consumer readiness")
    expect(transport.snapshot().requests[0].terminal).toBe("failed")
    transport.stop()
  })
  it("fails a final ready sample returned after the deadline and preserves the decision sample", async () => {
    let now = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const forum = { ...target, kind: "forum" as const, forumPostTestId: "community-forum-thread-card-post" }
    document.querySelector("main")!.innerHTML = '<div data-testid="community-forum-post-list"><div data-testid="community-forum-thread-card-post">typed post</div></div>'
    sizeContents(document.querySelector("main")!)
    let samples = 0
    const page = { evaluate: vi.fn(async () => {
      const sample = inspectConversationReadiness(forum)
      if (++samples === 3) {
        await Promise.resolve()
        now = 1_031
      }
      return sample
    }) } as unknown as Page
    const attach = vi.fn(async (_name: string, _options: { body?: string | Buffer; contentType?: string }) => {})
    const info = { attach } as unknown as TestInfo
    await expect(expectConversationReady(page, forum, info, 30)).rejects.toThrow("deadline includes final decision sample")
    const evidence = JSON.parse(String(attach.mock.calls[0][1].body))
    expect(evidence.accepted).toBe(false)
    expect(evidence.decisionState.ready).toBe(true)
    expect(evidence.decisionReceivedAt).toBe(1_031)
    expect(evidence.deadline).toBe(1_030)
    expect(evidence.lateState).toBeUndefined()
    expect(samples).toBe(3)
  })
  it.each([404, 503])("status %s cannot be forgiven by usable content", (status) => {
    const { events, transport, request } = fixture()
    expect(inspectConversationReadiness(target).ready).toBe(true)
    events.emit("request", request)
    events.emit("response", { request: () => request, status: () => status, url: request.url })
    expect(() => transport.assertHealthy()).toThrow()
    transport.stop()
  })
  it("fails client exceptions and keeps an unfinished request pending", () => {
    const { events, transport, request } = fixture()
    events.emit("request", request)
    expect(transport.snapshot().requests[0].terminal).toBe("pending")
    events.emit("pageerror", new Error("unresolved Flight child"))
    expect(() => transport.assertHealthy()).toThrow()
    transport.stop()
  })
  it("fails a target API 401 even when cached DOM appears ready", () => {
    const { events, transport } = fixture()
    const request = { url: () => "http://localhost/api/community/channels/channel/messages", headers: () => ({}), method: () => "GET" }
    events.emit("request", request)
    events.emit("response", { request: () => request, status: () => 401, url: request.url })
    expect(inspectConversationReadiness(target).ready).toBe(true)
    expect(() => transport.assertHealthy()).toThrow()
    transport.stop()
  })
})

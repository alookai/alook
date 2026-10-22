import type { OpenProfile } from "@/components/community/social/profile-types"
import type { ReactNode } from "react"
import type { UnreadServer } from "@/lib/community/models/inbox"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, setupUser } from "@/test/react-dom-harness"
import LandingInteractiveShell from "./landing-interactive-shell"
import { DEMO_CHANNELS, DEMO_MESSAGES, DEMO_PROFILES, DEMO_SERVERS, DEMO_MENTIONS, DEMO_UNREADS } from "./landing-interactive-shell-data"

const viewport = vi.hoisted(() => ({ breakpoint: "desktop" as "desktop" | "mobile" }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => viewport.breakpoint, useIsMobile: () => viewport.breakpoint === "mobile" }))
vi.mock("@/components/community/shell/community-shell-layout", () => ({ CommunityShellLayout: ({ rail, sidebar, main, userBar, overlays }: Record<string, ReactNode>) => <div>{rail}{sidebar}{main}{userBar}{overlays}</div> }))
vi.mock("@/components/community/shell/community-inbox-popover", () => ({ InboxPopover: ({ unreads, onOpenChannel }: { unreads: UnreadServer[]; onOpenChannel: (server: UnreadServer, channel: UnreadServer["channels"][number]) => void }) => <div>{unreads.flatMap((server) => server.channels.map((channel) => <button key={channel.channelId} onClick={() => onOpenChannel(server, channel)}>{channel.channelName} {channel.mentionCount}</button>))}</div> }))
vi.mock("@/components/community/shell/user-bar", () => ({ UserBar: ({ unreadCount, inbox, inboxOpen, onInboxOpenChange, onOpenProfile, extension }: { onOpenProfile: () => void; extension: { active: string; profile: ReactNode; profileCompanion: ReactNode }; unreadCount: number; inbox: ReactNode; inboxOpen: boolean; onInboxOpenChange: (open: boolean) => void }) => <div><button onClick={onOpenProfile}>Profile</button>{extension.active === "profile" && <>{extension.profileCompanion}{extension.profile}</>}<span>{unreadCount} unread conversations or requests</span><button onClick={() => onInboxOpenChange(!inboxOpen)}>Inbox</button>{inboxOpen && inbox}</div> }))
vi.mock("@/components/community/messages/composer", () => ({ Composer: ({ onAcceptSend }: { onAcceptSend: (text: string) => boolean }) => <button onClick={() => onAcceptSend("A local test message")}>Send test message</button> }))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: ({ onOpenProfile, messages, unreadCount, onJumpToPresent, typingUsers, onScrollRoot, newDividerBefore }: { onOpenProfile?: OpenProfile; newDividerBefore?: string; onScrollRoot?: (el: HTMLDivElement | null) => void; typingUsers?: string[]; messages: { id: string; content: string }[]; unreadCount: number; onJumpToPresent: () => void }) => <div ref={onScrollRoot} data-testid="mock-message-scroll"><button onClick={(event) => onOpenProfile?.("Alli", event, undefined, "demo-alli")}>Open Alli profile</button><span data-testid="new-divider">{newDividerBefore}</span><span data-testid="typing-names">{typingUsers?.join(", ")}</span>{messages.map((message) => <p key={message.id}>{message.content}</p>)}{unreadCount > 0 && <button onClick={onJumpToPresent}>Catch up {unreadCount}</button>}</div> }))

beforeEach(() => { viewport.breakpoint = "desktop"; vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("interactive landing workspace", () => {
  it.each(["mobile", "desktop"] as const)("opens a bot profile with the expected %s companion", async (breakpoint) => {
    viewport.breakpoint = breakpoint
    render(<LandingInteractiveShell />)
    fireEvent.click(screen.getByRole("button", { name: "Open Alli profile" }))
    expect(await screen.findByPlaceholderText("Message @Alli")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Open owner profile/ })).toBeInTheDocument()
    expect(screen.getByText("Bot log")).toBeInTheDocument()
  })
  it("announces readiness even when the hidden frame gets no animation callbacks", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {})
    render(<LandingInteractiveShell />)
    expect(post).toHaveBeenCalledWith({ type: "alook-demo-ready" }, window.location.origin)
  })
  it("has three populated spaces and people sharing agents with different owners", () => {
    expect(DEMO_SERVERS).toHaveLength(3)
    for (const server of DEMO_SERVERS) {
      const groups = DEMO_CHANNELS[server.id]
      expect(groups.some((group) => group.private)).toBe(true)
      expect(groups.some((group) => !group.private)).toBe(true)
      expect(groups.flatMap((group) => group.channels).length).toBeGreaterThanOrEqual(8)
      for (const channel of groups.flatMap((group) => group.channels)) {
        expect(DEMO_MESSAGES[channel.id].length).toBeGreaterThanOrEqual(3)
        for (const message of DEMO_MESSAGES[channel.id]) {
          expect(DEMO_PROFILES.has(message.authorId!)).toBe(true)
          expect(message.content).not.toMatch(/[\u4e00-\u9fff]/)
        }
      }
    }
    const authors = new Set(DEMO_MESSAGES["demo-general"].map((message) => message.authorId))
    expect([...authors].filter((id) => DEMO_PROFILES.get(id!)?.kind === "human")).toHaveLength(3)
    expect(DEMO_PROFILES.get("demo-maya")?.ownerUserId).toBe("demo-shelly")
    expect(DEMO_PROFILES.get("demo-alli")?.ownerUserId).toBe("demo-gus")
  })
  it("keeps authored timelines ordered and mentions tied to actual requests", () => {
    const ids = new Set<string>()
    for (const rows of Object.values(DEMO_MESSAGES)) {
      rows.forEach((row, index) => {
        expect(ids.has(row.id)).toBe(false)
        ids.add(row.id)
        expect(row.seq).toBe(index + 1)
        if (index > 0) expect(Date.parse(row.createdAt!)).toBeGreaterThan(Date.parse(rows[index - 1].createdAt!))
        expect(row.content).not.toMatch(/sample workspace|try the input|reset when|I’ll pick this up with Tracy/i)
      })
    }
    for (const [channel, ids] of Object.entries(DEMO_MENTIONS)) {
      for (const id of ids) {
        const row = DEMO_MESSAGES[channel].find((row) => row.id === id)
        expect(row?.content).toContain("@Gus#1813")
        expect(DEMO_MESSAGES[channel].slice(-DEMO_UNREADS[channel])).toContain(row)
      }
    }
  })
  it("catches up, reduces the Inbox count, and keeps local messages in their room", async () => {
    render(<LandingInteractiveShell />)
    expect(screen.getByTestId("typing-names")).toHaveTextContent("Alli")
    expect(screen.getByText("3 unread conversations or requests")).toBeInTheDocument()
    const divider = screen.getByTestId("new-divider").textContent
    fireEvent.click(screen.getByRole("button", { name: "Catch up 3" }))
    expect(screen.getByTestId("new-divider")).toHaveTextContent(divider!)
    expect(screen.getByText("2 unread conversations or requests")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }))
    expect(await screen.findByText("A local test message")).toBeVisible()
    expect(screen.getByTestId("new-divider")).toHaveTextContent(divider!)
    fireEvent.click(screen.getByRole("button", { name: "design-review" }))
    expect(screen.getByTestId("typing-names")).toBeEmptyDOMElement()
    expect(screen.queryByText("A local test message")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Catch up 2" }))
    expect(screen.getByText("1 unread conversations or requests")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "general" }))
    expect(screen.getByText("A local test message")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Reset demo" })).toBeNull()
  })
  it("clears the selected room when ordinary scrolling reaches the bottom", () => {
    render(<LandingInteractiveShell />)
    const root = screen.getByTestId("mock-message-scroll")
    Object.defineProperties(root, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 }, scrollTop: { value: 500, writable: true } })
    fireEvent.scroll(root)
    expect(screen.getByText("3 unread conversations or requests")).toBeInTheDocument()
    root.scrollTop = 800
    fireEvent.scroll(root)
    expect(screen.getByText("2 unread conversations or requests")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Catch up 3" })).toBeNull()
  })
  it("opens an Inbox room at the latest messages and clears its unread immediately", async () => {
    render(<LandingInteractiveShell />)
    await setupUser().click(screen.getByRole("button", { name: "Inbox" }))
    fireEvent.click(await screen.findByRole("button", { name: "design-review 0" }))
    expect(screen.getByText("2 unread conversations or requests")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Catch up 2" })).toBeNull()
    expect(screen.getByText(DEMO_MESSAGES["demo-design-review"].at(-1)!.content!)).toBeVisible()
  })
  it("toggles the user profile and lists only Gus’s five running bots", async () => {
    render(<LandingInteractiveShell />)
    await setupUser().click(screen.getByRole("button", { name: "Profile" }))
    expect(screen.getByRole("region", { name: "Running bots" })).toBeVisible()
    expect(screen.getByLabelText("5 running bots")).toBeVisible()
    expect(screen.getByRole("button", { name: "Open Alli activity" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Open Maya activity" })).toBeNull()
    await setupUser().click(screen.getByRole("button", { name: "Profile" }))
    expect(screen.queryByRole("region", { name: "Running bots" })).toBeNull()
  })
  it("opens Friends, My Bots and Machines as populated pages", () => {
    render(<LandingInteractiveShell />)
    fireEvent.click(screen.getAllByRole("link", { name: "Home" })[0])
    expect(screen.getByPlaceholderText("Search friends")).toBeVisible()
    expect(screen.getByRole("link", { name: "Alli" })).toHaveTextContent(/^Alli$/)
    fireEvent.click(screen.getByRole("link", { name: "My Bots" }))
    expect(screen.getByRole("heading", { name: "My Bots" })).toBeVisible()
    expect(screen.getByRole("button", { name: /Active Bots: 5/ })).toBeVisible()
    fireEvent.click(screen.getByRole("link", { name: "Machines" }))
    expect(screen.getByRole("heading", { name: "Machines" })).toBeVisible()
    expect(screen.getByText("Gus’s MacBook Pro")).toBeVisible()
  })
})

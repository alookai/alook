import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import { DEMO_PROFILES } from "./landing-interactive-shell-data"
import { DEMO_BOT_LOGS, LandingBotLog } from "./landing-bot-log"

vi.mock("@/hooks/community/use-bot-audit-preview", () => ({ useBotAuditPreview: () => { throw new Error("Preview must not fetch audit logs") } }))
vi.mock("@/hooks/community/use-bot-marks", () => ({ useBotMarks: () => { throw new Error("Preview must not fetch marks") } }))
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })

describe("landing bot logs", () => {
  it("gives every bot distinct fixed thoughts, real marked messages, and a running status", () => {
    const bots = [...DEMO_PROFILES.values()].filter((profile) => profile.kind === "bot")
    expect(Object.keys(DEMO_BOT_LOGS)).toHaveLength(bots.length)
    expect(new Set(Object.values(DEMO_BOT_LOGS).map((log) => JSON.stringify(log.events.map((event) => event.payload)))).size).toBe(bots.length)
    for (const bot of bots) {
      expect(DEMO_BOT_LOGS[bot.id].events).toHaveLength(3)
      expect(DEMO_BOT_LOGS[bot.id].marks).toHaveLength(2)
      expect(bot.statusText).toBe("Working on it")
      for (const mark of DEMO_BOT_LOGS[bot.id].marks) {
        expect(mark.m.content).toBeTruthy()
        expect(mark.m.authorName).toBeTruthy()
      }
    }
  })
  it("switches the native notebook between local thoughts and marks without fetching", async () => {
    render(<QueryClientProvider client={new QueryClient()}><CommunityPreviewProfileOwner profiles={DEMO_PROFILES}><LandingBotLog botId="demo-alli" /></CommunityPreviewProfileOwner></QueryClientProvider>)
    expect(screen.getByRole("region", { name: "Bot log" })).toBeVisible()
    expect(screen.getByText((DEMO_BOT_LOGS["demo-alli"].events[0].payload as { text: string }).text)).toBeVisible()
    expect(screen.getByTestId("community-bot-audit-preview-active")).toBeVisible()
    expect(screen.queryByTitle("Open full audit log")).not.toBeInTheDocument()
    await setupUser().click(screen.getByText((DEMO_BOT_LOGS["demo-alli"].events[0].payload as { text: string }).text))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await setupUser().click(screen.getByRole("tab", { name: "Marked messages" }))
    expect(screen.getByText(DEMO_BOT_LOGS["demo-alli"].marks[0].m.content!)).toBeVisible()
    await setupUser().click(screen.getByRole("tab", { name: "Thoughts" }))
    expect(screen.getByRole("tabpanel", { name: "Recent thoughts" })).toBeVisible()
  })
})

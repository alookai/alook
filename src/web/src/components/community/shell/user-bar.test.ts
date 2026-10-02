import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { UserBar, UserBarSkeleton } from "./user-bar"
import { tid } from "@/lib/community/testids"

describe("UserBar", () => {
  it("adds a geometry-neutral running-bot ring and accessible count only while bots are live", () => {
    const running = renderToStaticMarkup(createElement(UserBar, {
      breakpoint: "desktop",
      user: { id: "u1", name: "User", avatar: "U", runningBotCount: 2 },
    }))
    const idle = renderToStaticMarkup(createElement(UserBar, {
      breakpoint: "desktop",
      user: { id: "u1", name: "User", avatar: "U", runningBotCount: 0 },
    }))

    expect(running).toContain(`data-testid="${tid.userBarRunningBotsRing}"`)
    expect(running).toContain(`data-testid="${tid.userBarRunningBotsGlow}"`)
    expect(running).toContain('aria-label="Open profile. 2 running bots."')
    expect(running).toContain("relative grid size-7 place-items-center rounded-full")
    expect(running).toContain("pointer-events-none absolute -inset-px")
    expect(running).toContain("focus-visible:ring-offset-4")
    expect(running).toContain("focus-visible:ring-offset-muted")
    expect(running).toContain("var(--running-bots-primary)")
    expect(readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8"))
      .toContain("--running-bots-primary: oklch(0.9 0.008 80);")
    expect(running).not.toContain("color-mix")
    expect(running).not.toContain("var(--primary)")
    expect(running).not.toContain("var(--status-online)")
    expect(idle).toContain('aria-label="Open profile"')
    expect(idle).not.toContain(tid.userBarRunningBotsRing)
    expect(idle).not.toContain(tid.userBarRunningBotsGlow)
  })

  it("keeps the gradient ring static while reduced motion disables only its glow", () => {
    const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8")
    const reducedMotion = css.slice(css.indexOf("@keyframes user-bar-running-bots-breathe"))

    expect(reducedMotion).toContain(".user-bar-running-bots-glow")
    expect(reducedMotion).toContain("animation: user-bar-running-bots-breathe 2.8s")
    expect(reducedMotion).toContain("@media (prefers-reduced-motion: reduce)")
    expect(reducedMotion).toContain("animation: none")
    expect(reducedMotion).not.toContain("community-user-bar-running-bots-ring")
  })

  it("keeps the name shrinkable and truncated while the action group stays fixed", () => {
    const html = renderToStaticMarkup(createElement(UserBar, {
      breakpoint: "desktop",
      user: {
        id: "u1",
        name: "A display name that is intentionally much longer than the available sidebar width",
        avatar: "A",
      },
    }))

    expect(html).toContain(`data-testid="${tid.userBar}"`)
    expect(html).toContain("pl-[max(0.75rem,var(--app-safe-area-left))]")
    expect(html).toContain("pr-[max(0.75rem,var(--app-safe-area-right))]")
    expect(html).toContain("pb-[calc(0.75rem+var(--app-safe-area-bottom))]")
    expect(html).toContain("sm:px-2 sm:pb-3")
    expect(html).toContain("flex h-12 items-center gap-3 border border-border/40 bg-muted px-4")
    expect(html).not.toContain("ring-1 ring-border/40")
    expect(html).toContain('class="flex min-w-0 flex-1 items-center gap-2"')
    expect(html).toContain('data-testid="community-user-bar-name"')
    expect(html).toContain('class="truncate text-sm font-medium leading-tight"')
    expect(html).toContain('class="flex shrink-0 items-center gap-1"')
    const desktopSettingsClass = html.match(
      /class="([^"]*)" aria-label="User settings"/,
    )?.[1]?.split(" ")
    expect(desktopSettingsClass).toContain("hover:bg-accent")
  })

  it("keeps the mobile Settings action as a color-only icon button", () => {
    const html = renderToStaticMarkup(createElement(UserBar, {
      breakpoint: "mobile",
      user: { id: "u1", name: "User", avatar: "U" },
    }))
    const settingsClass = html.match(
      /class="([^"]*)" aria-label="User settings"/,
    )?.[1]?.split(" ")
    expect(settingsClass).toContain("hover:text-foreground")
    expect(settingsClass).toContain("active:text-foreground")
    expect(settingsClass).not.toContain("hover:bg-accent")
    expect(settingsClass).not.toContain("border")
    expect(settingsClass).not.toContain("shadow")
    expect(settingsClass).toContain("focus-visible:ring-2")
  })

  it("provides an inert account-neutral placeholder with the same Composer-aligned geometry", () => {
    const html = renderToStaticMarkup(createElement(UserBarSkeleton))
    expect(html).toContain(`data-testid="${tid.initialUserBarPending}"`)
    expect(html).toContain("aria-hidden=\"true\"")
    expect(html).toContain("pl-[max(0.75rem,var(--app-safe-area-left))]")
    expect(html).toContain("pr-[max(0.75rem,var(--app-safe-area-right))]")
    expect(html).toContain("pb-[calc(0.75rem+var(--app-safe-area-bottom))]")
    expect(html).toContain("sm:px-2 sm:pb-3")
    expect(html).toContain(
      "flex h-12 items-center gap-3 rounded-xl border border-border/40 bg-muted px-4",
    )
    expect(html).not.toContain("ring-1 ring-border/40")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("<a")
  })

  it("joins the mobile Inbox and Profile to the user bar without seam radii", () => {
    const openHtml = renderToStaticMarkup(createElement(UserBar, {
      breakpoint: "mobile",
      user: { id: "u1", name: "User", avatar: "U" },
      inboxOpen: true,
    }))
    expect(openHtml).toContain(
      'class="flex h-12 items-center gap-3 border border-border/40 bg-muted px-4 rounded-b-xl"',
    )

    const closedHtml = renderToStaticMarkup(createElement(UserBar, {
      breakpoint: "mobile",
      user: { id: "u1", name: "User", avatar: "U" },
      inboxOpen: false,
    }))
    expect(closedHtml).toContain(
      'class="flex h-12 items-center gap-3 border border-border/40 bg-muted px-4 rounded-xl"',
    )

    const profileHtml = renderToStaticMarkup(createElement(UserBar, {
      breakpoint: "mobile",
      user: { id: "u1", name: "User", avatar: "U" },
      extension: {
        active: "profile",
        inbox: null,
        profile: createElement("div", null, "Profile"),
        update: null,
        updateBadgePhase: null,
        eligibleMachines: [],
        onOpenUpdate: () => {},
        onRequestUpdate: () => {},
        onDismiss: () => {},
      },
    }))
    expect(profileHtml).toContain(
      'class="flex h-12 items-center gap-3 border border-border/40 bg-muted px-4 rounded-b-xl"',
    )
  })

  it("preserves the desktop Inbox name while mobile exposes open state", () => {
    const extension = {
      active: "none" as const,
      inbox: createElement("div", null, "Inbox content"),
      profile: null,
      update: null,
      updateBadgePhase: null,
      eligibleMachines: [],
      onOpenUpdate: () => {},
      onRequestUpdate: () => {},
      onDismiss: () => {},
    }
    const props = {
      user: { id: "u1", name: "User", avatar: "U" },
      inbox: createElement("div", null, "Inbox content"),
      hasUnread: false,
      inboxOpen: false,
      extension,
    }

    const desktop = renderToStaticMarkup(createElement(UserBar, {
      ...props,
      breakpoint: "desktop",
    }))
    expect(desktop).toContain('aria-label="Inbox"')
    expect(desktop).not.toContain('aria-label="Open Inbox"')

    const mobile = renderToStaticMarkup(createElement(UserBar, {
      ...props,
      breakpoint: "mobile",
    }))
    expect(mobile).toContain('aria-label="Open Inbox"')
  })

  it.each(["desktop", "mobile"] as const)(
    "renders the %s Update badge as one accessible icon without status text",
    (breakpoint) => {
      const html = renderToStaticMarkup(createElement(UserBar, {
        breakpoint,
        user: { id: "u1", name: "User", avatar: "U" },
        hasUnread: false,
        extension: {
          active: "none",
          inbox: null,
          profile: null,
          update: null,
          updateBadgePhase: "collapsedBadge",
          eligibleMachines: [],
          onOpenUpdate: () => {},
          onRequestUpdate: () => {},
          onDismiss: () => {},
        },
      }))
      const badge = html.match(new RegExp(
        `<button[^>]*data-testid="${tid.daemonUpdateBadge}"[^>]*>(.*?)</button>`,
      ))?.[1]

      expect(html).toContain('aria-label="Open machine update"')
      expect(badge).toContain("<svg")
      expect(badge).not.toContain("<span")
      expect(badge).not.toContain("Update")
      expect(badge).not.toContain("Updating")
      expect(badge).not.toContain("Retry")
    },
  )

  it("keeps the Inbox glyph outlined and expresses open state on its trigger", () => {
    const renderInbox = (open: boolean) => renderToStaticMarkup(createElement(UserBar, {
      breakpoint: "desktop",
      user: { id: "u1", name: "User", avatar: "U" },
      inbox: createElement("div", null, "Inbox content"),
      hasUnread: false,
      inboxOpen: open,
      extension: {
        active: open ? "inbox" : "none",
        inbox: createElement("div", null, "Inbox content"),
        profile: null,
        update: null,
        updateBadgePhase: null,
        eligibleMachines: [],
        onOpenUpdate: () => {},
        onRequestUpdate: () => {},
        onDismiss: () => {},
      },
    }))

    const closed = renderInbox(false)
    const open = renderInbox(true)

    expect(closed).toContain('aria-expanded="false"')
    expect(open).toContain('aria-expanded="true"')
    expect(closed).toContain("aria-expanded:bg-accent")
    expect(closed).toContain("aria-expanded:text-foreground")
    expect(open).toContain("aria-expanded:bg-accent")
    expect(open).toContain("aria-expanded:text-foreground")
    expect(closed).not.toContain("fill-current")
    expect(open).not.toContain("fill-current")
  })
})

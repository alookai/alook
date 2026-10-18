import { createContext, createElement, useContext, useState, type ReactNode } from "react"
import { act, render, screen } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CommunityNavigationTransition } from "./community-navigation-transition"
import { COMMUNITY_NAV_BACK, COMMUNITY_NAV_FORWARD } from "@/lib/community/navigation-transition"

const captures = vi.hoisted(() => ({ updates: [] as unknown[] }))
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  ViewTransition: ({ update, children }: { update: unknown; children: ReactNode }) => {
    captures.updates.push(update)
    return children
  },
}))

const Target = createContext("/c/me")

function StatefulPage() {
  const target = useContext(Target)
  const [draft, setDraft] = useState("unfinished draft")
  return createElement("div", null,
    createElement("span", null, target),
    createElement("input", { "aria-label": "Draft", value: draft, onChange: (event) => setDraft(event.target.value) }),
  )
}

function presentation(targetHref: string, transitionTypes?: string[], mobile = true) {
  return createElement(CommunityNavigationTransition, { mobile, targetHref, transitionTypes },
    createElement(Target, { value: targetHref }, createElement(StatefulPage)),
  )
}

describe("deferred community page presentation", () => {
  beforeEach(() => { captures.updates = [] })

  it("passes a synchronous target/context change through a deferred transition without remounting page state", async () => {
    const renderer = render(presentation("/c/me"))
    const input = screen.getByRole("textbox", { name: "Draft" })
    captures.updates = []
    await act(async () => { renderer.rerender(presentation("/c/me/dm1", [COMMUNITY_NAV_FORWARD])) })
    expect(screen.getByText("/c/me/dm1")).toBeInTheDocument()
    expect(captures.updates).toContain(COMMUNITY_NAV_FORWARD)
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input)
    expect(input).toHaveValue("unfinished draft")
    captures.updates = []
    await act(async () => { renderer.rerender(presentation("/c/me/dm1", [COMMUNITY_NAV_FORWARD])) })
    expect(renderer.container.querySelector("[data-community-navigation-target]")).toHaveAttribute("data-community-navigation-target", "/c/me/dm1")
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input)
  })

  it("uses the parent exit only on the changed target", async () => {
    const renderer = render(presentation("/c/me/dm1"))
    captures.updates = []
    await act(async () => { renderer.rerender(presentation("/c/me", [COMMUNITY_NAV_BACK])) })
    expect(captures.updates).toContain(COMMUNITY_NAV_BACK)
    expect(screen.getByText("/c/me")).toBeInTheDocument()
  })

  it("uses the semantic fallback for actual routes that bypass the shell controller", async () => {
    const renderer = render(presentation("/c/me/dm1"))
    captures.updates = []
    await act(async () => { renderer.rerender(presentation("/c/me/dm2")) })
    expect(captures.updates).toContain(COMMUNITY_NAV_FORWARD)
    captures.updates = []
    await act(async () => { renderer.rerender(presentation("/c/me")) })
    expect(captures.updates).toContain(COMMUNITY_NAV_BACK)
  })

  it("keeps same-leaf query updates still", async () => {
    const renderer = render(presentation("/c/me/dm1"))
    captures.updates = []
    await act(async () => { renderer.rerender(presentation("/c/me/dm1?msg=m1")) })
    expect(captures.updates.every((value) => value === "none")).toBe(true)
  })

  it("restores a cancelled preview without replaying the source's former entry type", async () => {
    const renderer = render(presentation("/c/me/dm1", [COMMUNITY_NAV_FORWARD]))
    await act(async () => { renderer.rerender(createElement(CommunityNavigationTransition, {
      mobile: true, targetHref: "/c/me", backPreview: { id: 1, href: "/c/me", committing: false },
    }, createElement(StatefulPage))) })
    captures.updates = []
    await act(async () => { renderer.rerender(presentation("/c/me/dm1", [COMMUNITY_NAV_FORWARD])) })
    expect(captures.updates.at(-2)).toBe("none")
  })

  it("keeps desktop page changes outside mobile motion", async () => {
    const renderer = render(presentation("/c/me", undefined, false))
    captures.updates = []
    await act(async () => { renderer.rerender(presentation("/c/me/dm1", [COMMUNITY_NAV_FORWARD], false)) })
    expect(captures.updates.every((value) => value === "none")).toBe(true)
  })
})

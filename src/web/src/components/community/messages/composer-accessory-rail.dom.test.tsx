import React from "react"
import { createPortal } from "react-dom"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { ComposerAccessoryRail } from "./composer-accessory-rail"
import { ConversationFooterShell, ConversationFooterSlotProvider, useConversationFooterSlot } from "./conversation-footer-shell"

vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value),
}))

describe("ComposerAccessoryRail geometry", () => {
  it("keeps present repeatable without loading presentation and retains failure retry", () => {
    const onScroll = vi.fn(), onNew = vi.fn()
    const view = (error: boolean, mode: "scroll" | "jump" = "jump") => <ComposerAccessoryRail typingNames={[]}
      scrollCount={0} scrollMode={mode} onScroll={onScroll} scrollError={error}
      newVisible onNew={onNew} />
    const renderer = render(view(false))
    const rail = renderer.getByTestId(tid.composerAccessoryRail)
    const present = renderer.getByRole("button", { name: "Jump to present" })
    expect(present).toBeEnabled()
    expect(present).not.toHaveAttribute("aria-busy", "true")
    expect(renderer.queryByRole("status")).toBeNull()
    fireEvent.click(present)
    fireEvent.click(present)
    expect(onScroll).toHaveBeenCalledTimes(2)
    renderer.rerender(view(true))
    expect(renderer.getByTestId(tid.composerAccessoryRail)).toBe(rail)
    expect(rail).toHaveStyle({ height: "32px" })
    fireEvent.click(renderer.getByRole("button", { name: "Could not load recent messages. Retry" }))
    expect(onScroll).toHaveBeenCalledTimes(3)
    fireEvent.click(renderer.getByRole("button", { name: "Jump to New" }))
    expect(onNew).toHaveBeenCalledOnce()
    renderer.rerender(view(false, "scroll"))
    expect(renderer.queryByTestId(tid.scrollToPresent)).toBeNull()
  })

  it("retains the typing status and independent actions while the center joins and leaves New", () => {
    const onNew = vi.fn(), onScroll = vi.fn()
    const view = (count: number, pending = false) => <ComposerAccessoryRail typingNames={["Alice"]} scrollCount={count}
      scrollMode="scroll" onScroll={onScroll} newVisible newPending={pending} onNew={onNew} />
    const renderer = render(view(0))
    const typing = renderer.getByRole("status")
    expect(typing).toHaveTextContent("Alice is typing")
    expect(renderer.queryByTestId(tid.scrollToPresent)).toBeNull()
    fireEvent.click(renderer.getByRole("button", { name: "Jump to New" }))
    expect(onNew).toHaveBeenCalledOnce()
    expect(onScroll).not.toHaveBeenCalled()
    renderer.rerender(view(4))
    expect(renderer.getByRole("status")).toBe(typing)
    fireEvent.click(renderer.getByRole("button", { name: "Scroll to bottom, 4 more below" }))
    expect(onScroll).toHaveBeenCalledOnce()
    renderer.rerender(view(0))
    expect(renderer.getByRole("status")).toBe(typing)
    expect(renderer.getByRole("button", { name: "Jump to New" })).toBeDefined()
    renderer.rerender(view(0, true))
    expect(renderer.getByRole("status")).toBe(typing)
    expect(renderer.getByTestId(tid.scrollToNew)).toBeDisabled()
    expect(onNew).toHaveBeenCalledOnce()
  })

  it("shows New by itself, keeps the present action independent and keeps an accepted pending jump visible without changing the center count", () => {
    const onNew = vi.fn(), onScroll = vi.fn()
    const view = (pending: boolean, count = 0) => <ComposerAccessoryRail typingNames={[]} scrollCount={count} scrollMode="scroll"
      onScroll={onScroll} newVisible newPending={pending} onNew={onNew} />
    const renderer = render(view(false))
    expect(renderer.getByTestId(tid.composerAccessoryRail)).toBeDefined()
    expect(renderer.queryByTestId(tid.scrollToPresent)).toBeNull()
    fireEvent.click(renderer.getByRole("button", { name: "Jump to New" }))
    expect(onNew).toHaveBeenCalledOnce()
    expect(onScroll).not.toHaveBeenCalled()
    renderer.rerender(view(false, 8))
    expect(renderer.getByTestId(tid.scrollToNew)).toBeDefined()
    expect(renderer.getByTestId(tid.scrollToPresent)).toBeDefined()
    fireEvent.click(renderer.getByRole("button", { name: "Scroll to bottom, 8 more below" }))
    expect(onScroll).toHaveBeenCalledOnce()
    expect(onNew).toHaveBeenCalledOnce()
    renderer.rerender(view(true, 8))
    const pendingNew = renderer.getByRole("button", { name: "Jump to New" })
    expect(pendingNew).toBeDisabled()
    expect(pendingNew).toHaveAttribute("aria-busy", "true")
    expect(pendingNew).toHaveTextContent(/^New$/)
    fireEvent.click(pendingNew)
    expect(onNew).toHaveBeenCalledOnce()
    expect(renderer.getByTestId(tid.scrollToPresent)).toHaveTextContent("8")
    expect(renderer.getByTestId(tid.scrollToPresent)).not.toHaveAttribute("aria-busy", "true")
    renderer.rerender(view(false, 8))
    expect(pendingNew).toBeEnabled()
  })
  it.each([0, 8])("keeps New transport loading out of the center with bottom count %i", count => {
    const onNew = vi.fn(), onScroll = vi.fn()
    const renderer = render(<ComposerAccessoryRail typingNames={[]} scrollCount={count} scrollMode="scroll"
      onScroll={onScroll} newVisible newPending onNew={onNew} />)
    const pendingNew = renderer.getByRole("button", { name: "Jump to New" })
    expect(pendingNew).toBeDisabled()
    expect(pendingNew).toHaveTextContent(/^New$/)
    expect(renderer.queryByRole("button", { name: "Loading messages" })).toBeNull()
    if (count === 0) expect(renderer.queryByTestId(tid.scrollToPresent)).toBeNull()
    else {
      const center = renderer.getByRole("button", { name: "Scroll to bottom, 8 more below" })
      expect(center).toBeEnabled()
      expect(center).not.toHaveAttribute("aria-busy", "true")
      expect(center).toHaveTextContent("8")
      fireEvent.click(center)
      expect(onScroll).toHaveBeenCalledOnce()
    }
  })

  it("mounts the accessory rail inside the conversation footer accessory slot", () => {
    function Accessory() {
      const target = useConversationFooterSlot()?.accessoryTarget
      return target ? createPortal(
        <ComposerAccessoryRail typingNames={["Alice"]} scrollCount={2} scrollMode="scroll" onScroll={vi.fn()} />,
        target,
      ) : null
    }
    const renderer = render(
      <ConversationFooterSlotProvider>
        <Accessory />
        <ConversationFooterShell><div>composer</div></ConversationFooterShell>
      </ConversationFooterSlotProvider>,
    )

    const slot = renderer.container.querySelector('[data-slot="community-composer-accessory-slot"]')!
    expect(renderer.getByTestId(tid.composerAccessoryRail).parentElement).toBe(slot)
    expect(renderer.getByTestId(tid.typingIndicator)).toBeInTheDocument()
  })

  it("keeps the shared 32px rail height with scroll-to-present mounted", () => {
    const renderer = render(
      <ComposerAccessoryRail
        typingNames={[]}
        scrollCount={1}
        scrollMode="jump"
        onScroll={vi.fn()}
      />,
    )

    expect(renderer.getByTestId(tid.composerAccessoryRail)).toHaveStyle({ height: "32px" })
    expect(renderer.getByTestId(tid.scrollToPresent)).toBeInTheDocument()
  })
})

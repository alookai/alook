import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { fireEvent, render } from "@/test/react-dom-harness"
import { DmSidebar, DmSidebarSkeleton } from "./dm-sidebar"

describe("DmSidebar navigation intent", () => {
  it("keeps the pending DM sidebar inert and accessible", () => {
    const renderer = render(createElement(DmSidebarSkeleton))
    const aside = renderer.getByTestId(tid.dmSidebarPending)
    expect(aside).toHaveAttribute("aria-label", "Loading direct messages")
    expect(aside).toHaveAttribute("aria-busy", "true")
    expect(renderer.container.querySelectorAll("button")).toHaveLength(0)
  })

  it("keeps shortcuts outside the independently scrolling DM list", () => {
    const renderer = render(createElement(DmSidebar, {
      dms: [],
      activeDm: null,
      onPickDm: vi.fn(),
      onShowFriends: vi.fn(),
      onShowMachines: vi.fn(),
      onShowBots: vi.fn(),
    }))

    const aside = renderer.container.querySelector("aside")!
    expect(aside).toHaveClass("min-h-0")
    const shortcuts = renderer.container.querySelector('[data-slot="dm-sidebar-shortcuts"]')!
    const dmList = renderer.container.querySelector('[data-slot="dm-sidebar-list"]')!
    expect(shortcuts).toHaveClass("shrink-0")
    expect(shortcuts).not.toHaveClass("overflow-y-auto")
    expect(dmList).toHaveClass("min-h-0", "flex-1", "overflow-y-auto")
  })

  it("prefetches the fixed destinations on pointer and keyboard intent", () => {
    const onPrefetchFriends = vi.fn()
    const onPrefetchMachines = vi.fn()
    const onPrefetchBots = vi.fn()
    const onShowFriends = vi.fn()
    const onShowMachines = vi.fn()
    const onShowBots = vi.fn()
    const renderer = render(createElement(DmSidebar, {
      dms: [],
      activeDm: null,
      onPickDm: vi.fn(),
      onShowFriends,
      onPrefetchFriends,
      onShowMachines,
      onPrefetchMachines,
      onShowBots,
      onPrefetchBots,
    }))

    const [friends, machines, bots] = renderer.container.querySelectorAll("button")
    fireEvent.pointerEnter(friends!)
    fireEvent.focus(machines!)
    fireEvent.pointerEnter(bots!)

    expect(onPrefetchFriends).toHaveBeenCalledTimes(1)
    expect(onPrefetchMachines).toHaveBeenCalledTimes(1)
    expect(onPrefetchBots).toHaveBeenCalledTimes(1)
    expect(onShowFriends).not.toHaveBeenCalled()
    expect(onShowMachines).not.toHaveBeenCalled()
    expect(onShowBots).not.toHaveBeenCalled()

  })

  it("prefetches the intended DM without selecting it", () => {
    const onPrefetchDm = vi.fn()
    const onPickDm = vi.fn()
    const renderer = render(createElement(DmSidebar, {
      dms: [{
        id: "dm_1",
        userId: "user_1",
        name: "Melly",
        avatar: "M",
        status: "online",
        preview: "hello",
      }],
      activeDm: null,
      onPickDm,
      onPrefetchDm,
      onShowFriends: vi.fn(),
    }))

    fireEvent.focus(renderer.getByTestId(tid.dmRow("dm_1")))

    expect(onPrefetchDm).toHaveBeenCalledWith("dm_1")
    expect(onPickDm).not.toHaveBeenCalled()

  })

  it("uses the active row shape without a duplicate unread dot", () => {
    const dm = {
      id: "dm_1",
      userId: "user_1",
      name: "Melly",
      discriminator: "0001",
      avatar: "M",
      avatarVersion: 0,
      status: "online" as const,
      preview: "hello",
      unread: true,
    }
    const renderer = render(createElement(DmSidebar, {
      dms: [dm],
      activeDm: "dm_1",
      onPickDm: vi.fn(),
      onShowFriends: vi.fn(),
    }))
    const unreadDots = () => Array.from(renderer.container.querySelectorAll("span"))
      .filter((node) => node.className === "size-2 shrink-0 rounded-full bg-primary")
    expect(unreadDots()).toHaveLength(0)

    renderer.rerender(createElement(DmSidebar, {
      dms: [dm],
      activeDm: null,
      onPickDm: vi.fn(),
      onShowFriends: vi.fn(),
    }))
    expect(unreadDots()).toHaveLength(1)
  })
})

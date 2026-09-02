import { createElement } from "react"
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { DmSidebar, DmSidebarSkeleton } from "./dm-sidebar"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("DmSidebar navigation intent", () => {
  it("keeps the pending DM sidebar inert and accessible", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(DmSidebarSkeleton))
    })
    const aside = renderer.root.findByType("aside")
    expect(aside.props).toMatchObject({
      "data-testid": tid.dmSidebarPending,
      "aria-label": "Loading direct messages",
      "aria-busy": true,
    })
    expect(renderer.root.findAllByType("button")).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it("keeps shortcuts outside the independently scrolling DM list", async () => {
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(DmSidebar, {
        dms: [],
        activeDm: null,
        onPickDm: vi.fn(),
        onShowFriends: vi.fn(),
        onShowMachines: vi.fn(),
        onShowBots: vi.fn(),
      }))
    })

    const aside = renderer.root.findByType("aside")
    expect(aside.props.className).toContain("min-h-0")
    const shortcuts = renderer.root.findByProps({ "data-slot": "dm-sidebar-shortcuts" })
    const dmList = renderer.root.findByProps({ "data-slot": "dm-sidebar-list" })
    expect(shortcuts.props.className).toContain("shrink-0")
    expect(shortcuts.props.className).not.toContain("overflow-y-auto")
    expect(dmList.props.className).toContain("min-h-0")
    expect(dmList.props.className).toContain("flex-1")
    expect(dmList.props.className).toContain("overflow-y-auto")

    act(() => renderer.unmount())
  })

  it("prefetches the fixed destinations on pointer and keyboard intent", async () => {
    const onPrefetchFriends = vi.fn()
    const onPrefetchMachines = vi.fn()
    const onPrefetchBots = vi.fn()
    const onShowFriends = vi.fn()
    const onShowMachines = vi.fn()
    const onShowBots = vi.fn()
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(DmSidebar, {
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
    })

    const [friends, machines, bots] = renderer.root.findAllByType("button")
    act(() => friends!.props.onPointerEnter())
    act(() => machines!.props.onFocus())
    act(() => bots!.props.onPointerEnter())

    expect(onPrefetchFriends).toHaveBeenCalledTimes(1)
    expect(onPrefetchMachines).toHaveBeenCalledTimes(1)
    expect(onPrefetchBots).toHaveBeenCalledTimes(1)
    expect(onShowFriends).not.toHaveBeenCalled()
    expect(onShowMachines).not.toHaveBeenCalled()
    expect(onShowBots).not.toHaveBeenCalled()

    act(() => renderer.unmount())
  })

  it("prefetches the intended DM without selecting it", async () => {
    const onPrefetchDm = vi.fn()
    const onPickDm = vi.fn()
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(DmSidebar, {
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
    })

    const row = renderer.root.findByProps({ "data-testid": tid.dmRow("dm_1") })
    act(() => row.props.onFocus())

    expect(onPrefetchDm).toHaveBeenCalledWith("dm_1")
    expect(onPickDm).not.toHaveBeenCalled()

    act(() => renderer.unmount())
  })

  it("uses the active row shape without a duplicate unread dot", async () => {
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
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(DmSidebar, {
        dms: [dm],
        activeDm: "dm_1",
        onPickDm: vi.fn(),
        onShowFriends: vi.fn(),
      }))
    })
    const unreadDots = () => renderer.root.findAll((node) => (
      node.type === "span"
      && node.props.className === "size-2 shrink-0 rounded-full bg-primary"
    ))
    expect(unreadDots()).toHaveLength(0)

    await act(async () => {
      renderer.update(createElement(DmSidebar, {
        dms: [dm],
        activeDm: null,
        onPickDm: vi.fn(),
        onShowFriends: vi.fn(),
      }))
    })
    expect(unreadDots()).toHaveLength(1)
    act(() => renderer.unmount())
  })
})

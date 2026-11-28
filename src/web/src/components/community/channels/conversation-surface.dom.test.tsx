import React from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@/test/react-dom-harness"
import { ConversationActivityContext, ConversationPresentationContext } from "@/contexts/view-activity"
import { ConversationSurface } from "./conversation-surface"
import { MessageList } from "@/components/community/messages/message-list"
import { ConversationFooterShell } from "@/components/community/messages/conversation-footer-shell"

const mountSpy = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }))

vi.mock("@/components/community/messages/message-list", () => ({
  MessageList: vi.fn(function MessageListStub({ channelId }: { channelId?: string }) {
    React.useLayoutEffect(() => {
      mountSpy.mounted(channelId)
      return () => mountSpy.unmounted(channelId)
    }, [channelId])
    return React.createElement("div", { "data-testid": "stub-message-list", "data-channel-id": channelId })
  }),
}))

vi.mock("@/components/community/messages/conversation-footer-shell", () => ({
  ConversationFooterSlotProvider: ({ children }: { children: React.ReactNode }) => children,
  ConversationFooterShell: vi.fn(({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "stub-footer-shell", ...props }, children)),
}))

const mockedMessageList = vi.mocked(MessageList)
const mockedFooterShell = vi.mocked(ConversationFooterShell)

function ComposerActivityProbe() {
  const active = React.useContext(ConversationActivityContext)
  return React.createElement("div", { "data-testid": "composer-activity", "data-active": String(active) })
}

describe("ConversationSurface", () => {
  it("renders one unified shell across dm, text, and thread surfaces without remounting on prop updates", () => {
    mountSpy.mounted.mockReset()
    mountSpy.unmounted.mockReset()
    mockedMessageList.mockClear()
    mockedFooterShell.mockClear()

    const onFillHistory = vi.fn()
    const tree = (overrides: Partial<React.ComponentProps<typeof ConversationSurface>> = {}) => (
      <ConversationSurface
        channelId="ch_1"
        subtype="text"
        header={<header data-testid="surface-header">Header</header>}
        messageListProps={{
          channel: "general",
          messages: [],
          loading: false,
          onOpenThread: vi.fn(),
          onFillHistory,
        }}
        footer={<ComposerActivityProbe />}
        footerProps={{ "data-onboarding-target": "channel-composer", inert: false }}
        inputActive
        sidePanel={<aside data-testid="surface-panel" />}
        dialogs={<div data-testid="surface-dialog" />}
        {...overrides}
      />
    )

    const view = render(tree())
    const surface = view.container.querySelector('[data-slot="community-conversation-surface"]')!
    expect(surface.tagName).toBe("MAIN")
    expect(surface).toHaveAttribute("data-channel-id", "ch_1")
    expect(surface).toHaveAttribute("data-community-conversation-subtype", "text")
    expect(screen.getByTestId("surface-header")).toBeInTheDocument()
    expect(screen.getByTestId("stub-message-list")).toHaveAttribute("data-channel-id", "ch_1")
    expect(mockedMessageList.mock.calls.at(-1)?.[0]).toMatchObject({ channelId: "ch_1", onFillHistory })
    expect(screen.getByTestId("composer-activity")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("surface-panel")).toBeInTheDocument()
    expect(screen.getByTestId("surface-dialog")).toBeInTheDocument()
    expect(mountSpy.mounted).toHaveBeenCalledTimes(1)
    expect(mountSpy.unmounted).not.toHaveBeenCalled()

    view.rerender(tree({ loadingPending: true, loadingPendingLabel: "Loading conversation", inputActive: false }))
    expect(view.container.querySelector('[data-slot="community-conversation-surface"]')).toBe(surface)
    expect(surface).toHaveAttribute("aria-busy", "true")
    expect(surface).toHaveAttribute("aria-label", "Loading conversation")
    expect(screen.getByTestId("composer-activity")).toHaveAttribute("data-active", "false")
    expect(mountSpy.mounted).toHaveBeenCalledTimes(1)
    expect(mountSpy.unmounted).not.toHaveBeenCalled()

    view.rerender(tree({ embedded: true, subtype: "thread", loadingPending: true, loadingPendingLabel: "Loading thread" }))
    const embeddedSurface = view.container.querySelector('[data-slot="community-conversation-surface"]')!
    expect(embeddedSurface.tagName).toBe("DIV")
    expect(embeddedSurface).toHaveAttribute("data-community-conversation-subtype", "thread")
    expect(embeddedSurface).not.toHaveAttribute("aria-busy")
    expect(embeddedSurface).not.toHaveAttribute("aria-label")
    view.unmount()
  })

  it("supports bodyOverride for DM denied/blocked/error states without mounting MessageList", () => {
    mockedMessageList.mockClear()
    const view = render(
      <ConversationSurface
        channelId="dm_1"
        subtype="dm"
        header={<header data-testid="dm-header" />}
        bodyOverride={<div role="alert">Denied</div>}
        footer={null}
      />,
    )
    const surface = view.container.querySelector('[data-slot="community-conversation-surface"]')!
    expect(surface).toHaveAttribute("data-channel-id", "dm_1")
    expect(surface).not.toHaveAttribute("data-community-conversation-subtype")
    expect(screen.getByRole("alert")).toHaveTextContent("Denied")
    expect(mockedMessageList).not.toHaveBeenCalled()
    view.unmount()
  })

  it("clips translated message content below the header and activates the GPU layer only in overlay-gpu mode", async () => {
    const originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit")
    const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__")
    Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          alookKeyboard: {
            postMessage: async () => ({
              mode: "overlay-gpu",
              targetInset: 0,
              viewportWidth: 390,
              durationMs: 0,
              easing: "cubic-bezier(0.32, 0.72, 0, 1)",
              phase: "settled",
              sequence: 0,
            }),
          },
        },
      },
    })
    const tree = (presented: boolean) => (
      <ConversationPresentationContext value={presented}>
        <ConversationSurface
          channelId="ch_gpu"
          subtype="text"
          header={<header data-testid="surface-header">Header</header>}
          messageListProps={{
            channel: "general",
            messages: [],
            loading: false,
            onOpenThread: vi.fn(),
          }}
          footer={<ComposerActivityProbe />}
        />
      </ConversationPresentationContext>
    )
    const view = render(tree(true))
    try {
      const surface = view.container.querySelector('[data-slot="community-conversation-surface"]')!
      expect(surface).toHaveClass("overflow-hidden")
      const listLayer = view.container.querySelector('[data-slot="community-message-list-keyboard-layer"]')!
      await waitFor(() => expect(listLayer).toHaveAttribute("data-alook-kb-gpu-layer", "true"))
      expect(listLayer).toHaveClass("alook-kb-gpu-layer")

      view.rerender(tree(false))
      expect(listLayer).not.toHaveAttribute("data-alook-kb-gpu-layer")
      expect(listLayer).not.toHaveClass("alook-kb-gpu-layer")
    } finally {
      view.unmount()
      document.documentElement.style.removeProperty("--alook-keyboard-progress")
      document.documentElement.style.removeProperty("--alook-keyboard-bottom")
      document.documentElement.style.removeProperty("--alook-kb-translate-y")
      document.documentElement.style.removeProperty("--alook-kb-transition")
      document.documentElement.removeAttribute("data-alook-kb-animating")
      if (originalWebkit) Object.defineProperty(window, "webkit", originalWebkit)
      else Reflect.deleteProperty(window, "webkit")
      if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri)
      else Reflect.deleteProperty(window, "__TAURI__")
    }
  })
})

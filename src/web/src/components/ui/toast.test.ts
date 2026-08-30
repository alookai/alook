import { readFileSync } from "node:fs"
import React, { type ReactNode } from "react"
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

type MockToast = {
  actionProps?: { children?: ReactNode; onClick?: () => void }
  data?: { closeLabel?: string; icon?: ReactNode; testId?: string }
  description?: ReactNode
  id: string
  limited?: boolean
  onClose?: () => void
  title?: ReactNode
  type?: string
}

type MockManager = {
  add: (toast: Omit<MockToast, "id"> & { id?: string }) => string
  close: (id?: string) => void
  items: MockToast[]
  subscribe: (listener: () => void) => () => void
}

vi.mock("@base-ui/react/toast", async () => {
  const ReactModule = await import("react")
  const ManagerContext = ReactModule.createContext<{
    manager: MockManager
    toasts: MockToast[]
  } | null>(null)
  const CurrentToastContext = ReactModule.createContext<{
    manager: MockManager
    toast: MockToast
  } | null>(null)

  function createToastManager(): MockManager {
    const listeners = new Set<() => void>()
    const manager: MockManager = {
      items: [],
      add(toast) {
        const id = toast.id ?? `toast-${manager.items.length + 1}`
        manager.items = [{ ...toast, id }, ...manager.items.filter((item) => item.id !== id)]
        listeners.forEach((listener) => listener())
        return id
      },
      close(id) {
        const closing = id
          ? manager.items.filter((item) => item.id === id)
          : manager.items
        closing.forEach((item) => item.onClose?.())
        manager.items = id ? manager.items.filter((item) => item.id !== id) : []
        listeners.forEach((listener) => listener())
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    return manager
  }

  function Provider({
    children,
    limit = Number.POSITIVE_INFINITY,
    toastManager,
  }: {
    children: ReactNode
    limit?: number
    toastManager: MockManager
  }) {
    const [, rerender] = ReactModule.useReducer((value) => value + 1, 0)
    ReactModule.useEffect(() => toastManager.subscribe(rerender), [toastManager])
    const toasts = toastManager.items.map((toast, index) => ({
      ...toast,
      limited: index >= limit,
    }))
    return ReactModule.createElement(
      ManagerContext.Provider,
      { value: { manager: toastManager, toasts } },
      children,
    )
  }

  function useToastManager() {
    const context = ReactModule.useContext(ManagerContext)
    if (!context) throw new Error("Missing toast provider")
    return { toasts: context.toasts }
  }

  function Root({ children, swipeDirection, toast, ...props }: Record<string, unknown> & {
    children?: ReactNode
    swipeDirection?: string[]
    toast: MockToast
  }) {
    const context = ReactModule.useContext(ManagerContext)
    if (!context) throw new Error("Missing toast provider")
    return ReactModule.createElement(
      CurrentToastContext.Provider,
      { value: { manager: context.manager, toast } },
      ReactModule.createElement("toast-root", {
        ...props,
        "data-limited": toast.limited || undefined,
        onSwipeDismiss: () => context.manager.close(toast.id),
        swipeDirection,
      }, children),
    )
  }

  function CurrentToastElement({ as, children, ...props }: Record<string, unknown> & {
    as: string
    children?: ReactNode
  }) {
    const context = ReactModule.useContext(CurrentToastContext)
    if (!context) throw new Error("Missing current toast")
    const value = as === "toast-title" ? context.toast.title : context.toast.description
    return ReactModule.createElement(as, props, children ?? value)
  }

  function Action({ children, render: _render, ...props }: Record<string, unknown> & {
    children?: ReactNode
  }) {
    const context = ReactModule.useContext(CurrentToastContext)
    if (!context) throw new Error("Missing current toast")
    return ReactModule.createElement("button", {
      ...props,
      ...context.toast.actionProps,
    }, children ?? context.toast.actionProps?.children)
  }

  function Close({ children, render: _render, ...props }: Record<string, unknown> & {
    children?: ReactNode
  }) {
    const context = ReactModule.useContext(CurrentToastContext)
    if (!context) throw new Error("Missing current toast")
    return ReactModule.createElement("button", {
      ...props,
      onClick: () => context.manager.close(context.toast.id),
    }, children)
  }

  const passthrough = (as: string) => function Passthrough({ children, ...props }: Record<string, unknown> & {
    children?: ReactNode
  }) {
    return ReactModule.createElement(as, props, children)
  }

  return {
    Toast: {
      Action,
      Close,
      Content: passthrough("toast-content"),
      Description: (props: Record<string, unknown>) => ReactModule.createElement(CurrentToastElement, { ...props, as: "toast-description" }),
      Portal: passthrough("toast-portal"),
      Provider,
      Root,
      Title: (props: Record<string, unknown>) => ReactModule.createElement(CurrentToastElement, { ...props, as: "toast-title" }),
      Viewport: passthrough("toast-viewport"),
      createToastManager,
      useToastManager,
    },
  }
})

import {
  MessageNotificationToaster,
  messageNotification,
} from "./toast"

let renderer: ReactTestRenderer

function renderToaster() {
  act(() => {
    renderer = create(React.createElement(MessageNotificationToaster))
  })
}

function bySlot(slot: string): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.props["data-slot"] === slot)
}

describe("top-center message notification", () => {
  beforeEach(() => {
    act(() => messageNotification.close())
  })

  it("renders notifications added through the shared manager", () => {
    renderToaster()

    act(() => {
      messageNotification.add({
        description: "Install the latest daemon on this machine.",
        title: "Daemon update available",
        type: "warning",
      })
    })

    expect(renderer.root.findByType("toast-title").children).toEqual(["Daemon update available"])
    expect(renderer.root.findByType("toast-description").children).toEqual([
      "Install the latest daemon on this machine.",
    ])
    expect(bySlot("message-notification-icon")).toHaveLength(1)
  })

  it("mounts the external manager provider before authenticated producers", () => {
    const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8")
    expect(layout.indexOf("<MessageNotificationToaster />"))
      .toBeLessThan(layout.indexOf("<TooltipProvider>"))
  })

  it("uses semantic icon tones and removes the icon grid track when no icon exists", () => {
    renderToaster()

    act(() => {
      messageNotification.add({ id: "success", title: "Connected", type: "success" })
      messageNotification.add({ id: "error", title: "Failed", type: "error" })
      messageNotification.add({ id: "info", title: "FYI", type: "info" })
      messageNotification.add({ id: "loading", title: "Loading", type: "loading" })
      messageNotification.add({ id: "warning", title: "Caution", type: "warning" })
      messageNotification.add({ id: "plain", title: "Plain message" })
    })

    const icons = bySlot("message-notification-icon")
    expect(icons.map((icon) => icon.props.className)).toEqual(expect.arrayContaining([
      expect.stringContaining("bg-primary/10 text-primary"),
      expect.stringContaining("bg-destructive/10 text-destructive"),
      expect.stringContaining("bg-muted text-muted-foreground"),
      expect.stringContaining("bg-warning/15 text-warning"),
    ]))

    const contents = bySlot("message-notification-content")
    expect(contents.some((content) => content.props.className.includes("grid-cols-[minmax(0,1fr)_auto]"))).toBe(true)
    expect(contents.every((content) => content.props.className.includes("motion-reduce:transition-none"))).toBe(true)
    const textColumns = renderer.root.findAll((node) => typeof node.props.className === "string"
      && node.props.className.includes("row-start-1 flex min-w-0"))
    expect(textColumns.some((node) => node.props.className.includes("col-start-1"))).toBe(true)
    const loadingRoot = renderer.root.findAllByType("toast-root")
      .find((root) => root.findAllByType("toast-title")[0]?.children[0] === "Loading")
    const loadingIcon = loadingRoot?.findAllByType("svg")
      .find((icon) => String(icon.props.className).includes("animate-spin"))
    expect(loadingIcon?.props.className).toContain("motion-reduce:animate-none")
  })

  it("limits the visible stack to three and keeps the motion and swipe contract", () => {
    renderToaster()

    act(() => {
      for (let index = 1; index <= 4; index += 1) {
        messageNotification.add({ id: `stack-${index}`, title: `Message ${index}` })
      }
    })

    const roots = renderer.root.findAllByType("toast-root")
    expect(roots).toHaveLength(4)
    expect(roots.filter((root) => root.props["data-limited"])).toHaveLength(1)
    expect(roots[0].props.swipeDirection).toEqual(["up", "left", "right"])
    expect(roots[0].props.className).toContain("300ms_cubic-bezier(0.2,0.8,0.2,1)")
    expect(roots[0].props.className).toContain("motion-reduce:transition-none")
  })

  it("runs onClose for action dismissal, close, and swipe dismissal", () => {
    renderToaster()
    const onActionClose = vi.fn()
    const onButtonClose = vi.fn()
    const onSwipeClose = vi.fn()
    let actionId = ""

    act(() => {
      actionId = messageNotification.add({
        actionProps: {
          children: "View machines",
          onClick: () => messageNotification.close(actionId),
        },
        id: "action",
        onClose: onActionClose,
        title: "Action",
      })
      messageNotification.add({ id: "button", onClose: onButtonClose, title: "Close" })
      messageNotification.add({ id: "swipe", onClose: onSwipeClose, title: "Swipe" })
    })

    const roots = renderer.root.findAllByType("toast-root")
    const actionRoot = roots.find((root) => root.findAllByType("toast-title")[0]?.children[0] === "Action")
    const buttonRoot = roots.find((root) => root.findAllByType("toast-title")[0]?.children[0] === "Close")
    const swipeRoot = roots.find((root) => root.findAllByType("toast-title")[0]?.children[0] === "Swipe")
    if (!actionRoot || !buttonRoot || !swipeRoot) throw new Error("Expected all interaction fixtures")

    const actionButton = actionRoot.findAllByType("button").find((button) => button.props["data-slot"] === "message-notification-action")
    const closeButton = buttonRoot.findAllByType("button").find((button) => button.props["data-slot"] === "message-notification-close")
    if (!actionButton || !closeButton) throw new Error("Expected action and close controls")

    act(() => actionButton.props.onClick())
    act(() => closeButton.props.onClick())
    act(() => swipeRoot.props.onSwipeDismiss())

    expect(onActionClose).toHaveBeenCalledOnce()
    expect(onButtonClose).toHaveBeenCalledOnce()
    expect(onSwipeClose).toHaveBeenCalledOnce()
  })
})

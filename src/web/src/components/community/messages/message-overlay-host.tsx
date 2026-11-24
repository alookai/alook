"use client"

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { createStore, useSelector, type Store } from "@tanstack/react-store"
import { useMessageMarked } from "@/hooks/community/use-inbox"
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu"
import {
  MessageContextItems,
  MessageDropdownItems,
  type MessageLinkMenuHandlers,
  type MessageMenuHandlers,
} from "./message-menu"
import {
  copyMessageExternalLink,
  openMessageExternalLink,
  type MessageExternalLinkTarget,
} from "./message-external-link"

type MessageOverlayPointAnchor = {
  getBoundingClientRect: () => DOMRect
}

export type ActiveMessageOverlayMenu = {
  kind: "context" | "touch"
  messageId: string
  anchor: MessageOverlayPointAnchor
  rowEl: HTMLElement | null
  restoreFocusOnKeyboardClose: boolean
  linkTarget: MessageExternalLinkTarget | null
  handlers: Omit<MessageMenuHandlers, "marked">
}

type MessageOverlayState = {
  hoveredId: string | null
  toolbarOpenId: string | null
  activeMenu: ActiveMessageOverlayMenu | null
}

export type MessageOverlayHost = {
  store: Store<MessageOverlayState>
  setHovered: (messageId: string) => void
  clearHovered: (messageId: string) => void
  setToolbarOpen: (messageId: string, open: boolean) => void
  openMenu: (menu: ActiveMessageOverlayMenu) => void
  closeMenu: () => void
}

const MessageOverlayHostContext = createContext<MessageOverlayHost | null>(null)
const noopStore = createStore<MessageOverlayState>({
  hoveredId: null,
  toolbarOpenId: null,
  activeMenu: null,
})

export function useMessageOverlayHost(): MessageOverlayHost | null {
  return useContext(MessageOverlayHostContext)
}

export function useMessageOverlayToolbarActive(host: MessageOverlayHost | null, messageId: string): boolean {
  return useSelector(host ? host.store : noopStore, (state) => (
    host !== null && (state.hoveredId === messageId || state.toolbarOpenId === messageId)
  ))
}

export function useMessageOverlayToolbarOpen(host: MessageOverlayHost | null, messageId: string): boolean {
  return useSelector(host ? host.store : noopStore, (state) => (
    host !== null && state.toolbarOpenId === messageId
  ))
}

export function MessageDropdownItemsWithMark({
  messageId,
  touch = false,
  ...props
}: Omit<MessageMenuHandlers, "marked"> & MessageLinkMenuHandlers & {
  messageId: string
  touch?: boolean
}) {
  const { data: markedData } = useMessageMarked(messageId, Boolean(props.onMark))
  return <MessageDropdownItems {...props} marked={markedData?.marked ?? false} touch={touch} />
}

export function MessageContextItemsWithMark({
  messageId,
  ...props
}: Omit<MessageMenuHandlers, "marked"> & MessageLinkMenuHandlers & {
  messageId: string
}) {
  const { data: markedData } = useMessageMarked(messageId, Boolean(props.onMark))
  return <MessageContextItems {...props} marked={markedData?.marked ?? false} />
}

function SharedMessageMenuPortal({ store, closeMenu }: {
  store: Store<MessageOverlayState>
  closeMenu: () => void
}) {
  const activeMenu = useSelector(store, (state) => state.activeMenu)
  const linkMenuHandlers = useMemo<MessageLinkMenuHandlers>(() => ({
    linkTarget: activeMenu?.linkTarget ?? null,
    onCopyLink: (target: MessageExternalLinkTarget) => {
      void copyMessageExternalLink(target)
    },
    onOpenLink: (target: MessageExternalLinkTarget) => {
      void openMessageExternalLink(target)
    },
  }), [activeMenu?.linkTarget])

  return (
    <DropdownMenu
      open={Boolean(activeMenu)}
      onOpenChange={(open) => {
        if (!open) closeMenu()
      }}
    >
      {activeMenu && (
        <DropdownMenuContent
          data-message-touch-menu={activeMenu.kind === "touch" ? "" : undefined}
          anchor={activeMenu.anchor}
          positionMethod="fixed"
          side="bottom"
          align="start"
          collisionPadding={8}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          className={activeMenu.kind === "touch" ? "w-48 select-none" : "w-48"}
          finalFocus={activeMenu.kind === "context" && activeMenu.restoreFocusOnKeyboardClose
            ? (closeType) => {
                if (closeType === "keyboard") activeMenu.rowEl?.focus({ preventScroll: true })
                return false
              }
            : undefined}
        >
          <MessageDropdownItemsWithMark
            messageId={activeMenu.messageId}
            {...activeMenu.handlers}
            {...linkMenuHandlers}
            touch={activeMenu.kind === "touch"}
          />
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  )
}

export function MessageOverlayHostProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createStore<MessageOverlayState>({
    hoveredId: null,
    toolbarOpenId: null,
    activeMenu: null,
  }))

  const setHovered = useCallback((messageId: string) => {
    store.setState((current) => (current.hoveredId === messageId ? current : { ...current, hoveredId: messageId }))
  }, [store])

  const clearHovered = useCallback((messageId: string) => {
    store.setState((current) => (current.hoveredId === messageId ? { ...current, hoveredId: null } : current))
  }, [store])

  const setToolbarOpen = useCallback((messageId: string, open: boolean) => {
    store.setState((current) => {
      const next = open ? messageId : (current.toolbarOpenId === messageId ? null : current.toolbarOpenId)
      return current.toolbarOpenId === next ? current : { ...current, toolbarOpenId: next }
    })
  }, [store])

  const openMenu = useCallback((menu: ActiveMessageOverlayMenu) => {
    store.setState((current) => ({ ...current, activeMenu: menu }))
  }, [store])

  const closeMenu = useCallback(() => {
    store.setState((current) => (current.activeMenu === null ? current : { ...current, activeMenu: null }))
  }, [store])

  const host = useMemo<MessageOverlayHost>(() => ({
    store,
    setHovered,
    clearHovered,
    setToolbarOpen,
    openMenu,
    closeMenu,
  }), [clearHovered, closeMenu, openMenu, setHovered, setToolbarOpen, store])

  return (
    <MessageOverlayHostContext.Provider value={host}>
      {children}
      <SharedMessageMenuPortal store={store} closeMenu={closeMenu} />
    </MessageOverlayHostContext.Provider>
  )
}

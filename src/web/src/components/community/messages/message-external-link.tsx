"use client"

import type { ComponentPropsWithoutRef, MouseEvent } from "react"
import { isTauri } from "@alook/shared"
import { toast } from "sonner"

export const MESSAGE_EXTERNAL_LINK_ERROR = "Couldn't open link in your browser"

type OpenUrl = (url: string) => Promise<void>
type MessageLinkClickEvent = Pick<
  MouseEvent<HTMLAnchorElement>,
  "defaultPrevented" | "preventDefault" | "stopPropagation"
>

type TauriOpenerWindow = Window & {
  __TAURI__?: {
    opener?: {
      openUrl?: OpenUrl
    }
  }
}

function isAbsoluteHttpUrl(href: string | undefined): href is string {
  if (!href) return false
  try {
    const protocol = new URL(href).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

function readTauriOpenUrl(): OpenUrl | null {
  if (typeof window === "undefined") return null
  const openUrl = (window as TauriOpenerWindow).__TAURI__?.opener?.openUrl
  return openUrl ? (url) => openUrl(url) : null
}

export function handleMessageExternalLinkClick(
  event: MessageLinkClickEvent,
  href: string | undefined,
  options: {
    tauri?: boolean
    openUrl?: OpenUrl | null
    onError?: () => void
  } = {},
): Promise<void> | null {
  const tauri = options.tauri ?? isTauri()
  if (!tauri || event.defaultPrevented || !isAbsoluteHttpUrl(href)) return null

  event.preventDefault()
  event.stopPropagation()
  const onError = options.onError ?? (() => toast.error(MESSAGE_EXTERNAL_LINK_ERROR))
  const openUrl = options.openUrl === undefined ? readTauriOpenUrl() : options.openUrl
  if (!openUrl) {
    onError()
    return Promise.resolve()
  }

  try {
    return Promise.resolve(openUrl(href)).catch(() => {
      onError()
    })
  } catch {
    onError()
    return Promise.resolve()
  }
}

export function MessageExternalLink({
  href,
  onClick,
  children,
  ...props
}: ComponentPropsWithoutRef<"a">) {
  return (
    <a
      {...props}
      href={href}
      data-message-external-link
      onClick={(event) => {
        onClick?.(event)
        void handleMessageExternalLinkClick(event, href)
      }}
    >
      {children}
    </a>
  )
}

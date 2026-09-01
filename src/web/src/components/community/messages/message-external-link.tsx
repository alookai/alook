"use client"

import type { ComponentPropsWithoutRef, MouseEvent } from "react"
import { isTauri } from "@alook/shared"
import { toast } from "sonner"

export const MESSAGE_EXTERNAL_LINK_ERROR = "Couldn't open link in your browser"
export const MESSAGE_EXTERNAL_LINK_COPY_ERROR = "Couldn't copy link"
export const MESSAGE_EXTERNAL_LINK_COPY_SUCCESS = "Copied to clipboard"

export type MessageExternalLinkTarget = {
  href: string
}

type OpenUrl = (url: string) => Promise<void>
type OpenWindow = (url: string, target: string, features: string) => Window | null
type WriteText = (text: string) => Promise<void>
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

export function messageExternalLinkTargetFromEventTarget(
  target: EventTarget | null,
): MessageExternalLinkTarget | null {
  const anchor = (target as { closest?: (selector: string) => unknown } | null)
    ?.closest?.("a[data-message-external-link]") as { href?: unknown } | null | undefined
  const href = anchor?.href
  return typeof href === "string" && isAbsoluteHttpUrl(href) ? { href } : null
}

function readTauriOpenUrl(): OpenUrl | null {
  if (typeof window === "undefined") return null
  const openUrl = (window as TauriOpenerWindow).__TAURI__?.opener?.openUrl
  return openUrl ? (url) => openUrl(url) : null
}

export async function copyMessageExternalLink(
  target: MessageExternalLinkTarget,
  options: {
    writeText?: WriteText | null
    onSuccess?: () => void
    onError?: () => void
  } = {},
): Promise<boolean> {
  const onSuccess = options.onSuccess ?? (() => toast(MESSAGE_EXTERNAL_LINK_COPY_SUCCESS))
  const onError = options.onError ?? (() => toast.error(MESSAGE_EXTERNAL_LINK_COPY_ERROR))
  const writeText = options.writeText === undefined
    ? typeof navigator === "undefined"
      ? null
      : navigator.clipboard?.writeText.bind(navigator.clipboard) ?? null
    : options.writeText

  if (!isAbsoluteHttpUrl(target.href) || !writeText) {
    onError()
    return false
  }

  try {
    await writeText(target.href)
    onSuccess()
    return true
  } catch {
    onError()
    return false
  }
}

export function openMessageExternalLink(
  target: MessageExternalLinkTarget,
  options: {
    tauri?: boolean
    openUrl?: OpenUrl | null
    openWindow?: OpenWindow | null
    onError?: () => void
  } = {},
): Promise<void> {
  const onError = options.onError ?? (() => toast.error(MESSAGE_EXTERNAL_LINK_ERROR))
  if (!isAbsoluteHttpUrl(target.href)) {
    onError()
    return Promise.resolve()
  }

  const tauri = options.tauri ?? isTauri()
  if (tauri) {
    const openUrl = options.openUrl === undefined ? readTauriOpenUrl() : options.openUrl
    if (!openUrl) {
      onError()
      return Promise.resolve()
    }
    try {
      return Promise.resolve(openUrl(target.href)).catch(() => {
        onError()
      })
    } catch {
      onError()
      return Promise.resolve()
    }
  }

  const openWindow = options.openWindow === undefined
    ? typeof window === "undefined"
      ? null
      : window.open.bind(window)
    : options.openWindow
  if (!openWindow) {
    onError()
    return Promise.resolve()
  }
  try {
    // Browsers may return null for a successful `noopener` open because the
    // opener is deliberately severed, so only a missing/throwing API is a
    // reliable failure signal here.
    openWindow(target.href, "_blank", "noopener,noreferrer")
  } catch {
    onError()
  }
  return Promise.resolve()
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
  return openMessageExternalLink(
    { href },
    { tauri: true, openUrl: options.openUrl, onError: options.onError },
  )
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

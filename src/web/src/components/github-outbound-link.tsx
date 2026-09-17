"use client"

import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react"
import {
  trackGithubOutboundClicked,
  type GithubOutboundSurface,
} from "@/lib/analytics"

export const ALOOK_GITHUB_REPO_URL = "https://github.com/alookai/alook"

export function shouldTrackGithubOutboundClick(
  isTrusted: boolean,
  href: string | null,
) {
  return isTrusted && href === ALOOK_GITHUB_REPO_URL
}

export function GithubOutboundLink({
  surface,
  onClick,
  ...props
}: Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  surface: GithubOutboundSurface
}) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (shouldTrackGithubOutboundClick(event.isTrusted, event.currentTarget.getAttribute("href"))) {
      trackGithubOutboundClicked(surface)
    }
    onClick?.(event)
  }

  return (
    <a
      {...props}
      href={ALOOK_GITHUB_REPO_URL}
      onClick={handleClick}
    />
  )
}

export function GithubOutboundBoundary({
  surface,
  children,
}: {
  surface: GithubOutboundSurface
  children: ReactNode
}) {
  const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target
    const anchor = target instanceof Element ? target.closest("a") : null
    if (shouldTrackGithubOutboundClick(event.isTrusted, anchor?.getAttribute("href") ?? null)) {
      trackGithubOutboundClicked(surface)
    }
  }

  return <div style={{ display: "contents" }} onClickCapture={handleClickCapture}>{children}</div>
}

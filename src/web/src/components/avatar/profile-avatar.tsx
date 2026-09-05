"use client"

import { type ReactNode } from "react"
import {
  Avatar as UiAvatar,
  AvatarFallback,
} from "@/components/ui/avatar"
import { resolveAvatar } from "@/lib/avatar/resolve"
import { avatarInitial } from "@/lib/community/avatar"
import { cn } from "@/lib/utils"
import { RemoteIdentityImage } from "@/components/remote-image/remote-image"
import { GeneratedAvatar } from "./generated-avatar"

export type ProfileAvatarProps = {
  label: string
  src?: string | null
  seed?: string | null
  size?: number
  dim?: boolean
  alt?: string
  className?: string
  children?: ReactNode
  "data-testid"?: string
}

export function ProfileAvatar({
  label,
  src,
  seed,
  size = 32,
  dim = false,
  alt,
  className,
  children,
  "data-testid": testId,
}: ProfileAvatarProps) {
  const safeLabel = label || "?"
  const resolved = resolveAvatar(src || safeLabel, seed || undefined)
  const accessibleLabel = alt ?? safeLabel
  const decorative = accessibleLabel === ""

  return (
    <UiAvatar
      data-testid={testId}
      data-avatar-kind={resolved.kind}
      className={cn(resolved.kind === "beam" ? "after:hidden" : "bg-muted", className)}
      style={{ width: size, height: size, opacity: dim ? 0.4 : 1 }}
      role={resolved.kind === "photo" || decorative ? undefined : "img"}
      aria-label={resolved.kind === "photo" || decorative ? undefined : accessibleLabel}
      aria-hidden={decorative ? true : undefined}
    >
      {resolved.kind === "photo" ? (
        <RemoteIdentityImage
          src={resolved.url}
          alt={accessibleLabel}
          className="aspect-square rounded-full"
          placeholderClassName="rounded-full"
          profilePhoto
        />
      ) : resolved.kind === "beam" ? (
        <span className="size-full overflow-hidden rounded-full">
          <GeneratedAvatar seed={resolved.seed} size={size} className="size-full rounded-full" />
        </span>
      ) : (
        <AvatarFallback className="font-medium" style={{ fontSize: size * 0.4 }}>
          {avatarInitial(safeLabel)}
        </AvatarFallback>
      )}
      {children}
    </UiAvatar>
  )
}

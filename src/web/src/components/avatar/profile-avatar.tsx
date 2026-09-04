"use client"

import { useState, type ReactNode } from "react"
import {
  Avatar as UiAvatar,
  AvatarFallback,
} from "@/components/ui/avatar"
import { resolveAvatar } from "@/lib/avatar/resolve"
import { avatarInitial } from "@/lib/community/avatar"
import { cn } from "@/lib/utils"
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

function ProfilePhoto({ src, alt, fallback, fontSize }: {
  src: string
  alt: string
  fallback: string
  fontSize: number
}) {
  const [status, setStatus] = useState<"pending" | "ready" | "failed">("pending")

  if (status === "failed") {
    return (
      <AvatarFallback className="font-medium" style={{ fontSize }}>
        {fallback}
      </AvatarFallback>
    )
  }

  return (
    <>
      <AvatarFallback className="font-medium" style={{ fontSize }} aria-hidden>
        {fallback}
      </AvatarFallback>
      <img
        data-slot="avatar-image"
        data-avatar-photo-state={status}
        src={src}
        alt={alt}
        className={cn(
          "absolute inset-0 aspect-square size-full rounded-full object-cover",
          status === "ready" ? "opacity-100" : "opacity-0",
        )}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("failed")}
      />
    </>
  )
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
        <ProfilePhoto
          key={resolved.url}
          src={resolved.url}
          alt={accessibleLabel}
          fallback={avatarInitial(safeLabel)}
          fontSize={size * 0.4}
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

"use client"

import { AgentAvatar } from "@/components/avatar"
import { Avatar } from "@/components/community/avatar"
import { cn } from "@/lib/utils"
import type { ScheduleActor } from "./schedule-types"

export function ScheduleActorAvatar({
  actor,
  size = 20,
  className,
}: {
  actor: ScheduleActor
  size?: number
  className?: string
}) {
  if (actor.kind === "bot") {
    return (
      <AgentAvatar
        name={actor.name}
        avatarUrl={actor.avatarUrl}
        seed={actor.id}
        size={size}
        className={cn("shrink-0 [&_svg]:size-full!", className)}
        alt=""
      />
    )
  }
  return (
    <Avatar
      label={actor.name}
      seed={actor.id}
      src={actor.avatarUrl}
      size={size}
    />
  )
}

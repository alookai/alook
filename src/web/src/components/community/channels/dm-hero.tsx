"use client"

import type { DM } from "@/lib/community/models/people"
import type { OpenProfile } from "../social/profile-types"
import { Avatar } from "../avatar"

/** Top of a DM conversation: the peer's avatar (opens their profile), name and intro line. */
export function DmHero({ dm, onOpenProfile }: { dm: Pick<DM, "name" | "avatar" | "userId"> & { discriminator?: string | null }; onOpenProfile?: OpenProfile }) {
  return (
    <>
      <button
        type="button"
        data-slot="dm-hero-avatar"
        aria-label={`Open ${dm.name}'s profile`}
        disabled={!onOpenProfile}
        onClick={(event) => onOpenProfile?.(dm.name, event, dm.discriminator ?? undefined, dm.userId)}
        className="relative mb-3 w-fit rounded-full transition-transform duration-100 ease-out enabled:hover:-translate-y-px enabled:active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
      >
        <Avatar label={dm.avatar} seed={dm.userId} size={64} />
      </button>
      <h2 className="text-2xl font-semibold leading-tight">{dm.name}</h2>
      <p className="mt-1 text-sm text-muted-foreground">This is the beginning of your direct message history with <span className="font-medium text-foreground">{dm.name}</span>.</p>
    </>
  )
}

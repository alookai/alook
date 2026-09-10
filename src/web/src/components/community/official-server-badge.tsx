import Image from "next/image"
import { cn } from "@/lib/utils"

export function OfficialServerBadge({ official, className }: {
  official?: boolean
  className?: string
}) {
  if (!official) return null
  return (
    <Image
      src="/official-server-badge-flat.svg"
      alt="Official server"
      title="Official server"
      width={20}
      height={20}
      unoptimized
      draggable={false}
      className={cn("pointer-events-none size-5 shrink-0", className)}
    />
  )
}

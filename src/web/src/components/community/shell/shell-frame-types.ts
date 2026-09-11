import type { ReactNode } from "react"
import type { OwnerServerDeleteRouteToken } from "@/lib/community/eject-server"
import type { View } from "./shell-types"

export type ShellFrameProps = {
  view: View
  activeServerId: string | undefined
  frameHref: string
  sidebar: (opts?: { noHeader?: boolean }) => ReactNode
  children: ReactNode
  extraDialogs?: ReactNode
  onOpenActiveServerSettings?: () => void
  onOpenActiveServerInvite?: () => void
  ownerDeleteRouteScope?: {
    serverId: string
    token: OwnerServerDeleteRouteToken
  }
}

export type ShellRouter = {
  push: (href: string) => void
  pushImmediate?: (href: string) => void
  replace: (href: string) => void
  prefetch: (href: string) => void
}

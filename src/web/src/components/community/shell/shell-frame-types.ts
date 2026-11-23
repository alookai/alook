import type { OwnerServerDeleteRouteToken } from "@/stores/community/server-eject-store"
import type { ReactNode } from "react"

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
  captureIntent?: () => () => boolean
  push: (href: string) => void
  pushImmediate?: (href: string, prepare?: () => void) => void
  replace: (href: string) => void
}

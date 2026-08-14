import type { ReactNode } from "react"
import type { MobileZone } from "./mobile-zone"
import type { View } from "./shell-types"

export type ShellFrameProps = {
  view: View
  activeServerId: string | undefined
  mobileZone: MobileZone
  setMobileZone: (zone: MobileZone) => void
  sidebar: (opts?: { noHeader?: boolean }) => ReactNode
  children: ReactNode
  extraDialogs?: ReactNode
  onOpenActiveServerSettings?: () => void
  onOpenActiveServerInvite?: () => void
  goHome: () => void
  goServer: () => void
}

export type ShellRouter = {
  push: (href: string) => void
  replace: (href: string) => void
  prefetch: (href: string) => void
}

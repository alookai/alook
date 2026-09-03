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
}

export type ShellRouter = {
  push: (href: string) => void
  pushImmediate?: (href: string) => void
  replace: (href: string) => void
  prefetch: (href: string) => void
}

import type { ReactNode } from "react"
import { DmSidebarSlot } from "@/components/community/shell/dm-sidebar-slot"

export default function MeSidebarLayout({ children }: { children: ReactNode }) {
  return <><DmSidebarSlot />{children}</>
}

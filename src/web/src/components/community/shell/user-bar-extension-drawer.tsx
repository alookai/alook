"use client"

import { cloneElement, useState, type ReactElement } from "react"
import { Collapsible } from "@base-ui/react/collapsible"

type Content = ReactElement<{ interactive?: boolean; animate?: boolean }>

export function UserBarExtensionDrawer({ children }: { children: Content | null }) {
  const [retained, setRetained] = useState(children)
  if (children && children !== retained) setRetained(children)
  const open = children !== null
  const content = children ?? retained

  return (
    <Collapsible.Root open={open} className="community-user-bar-drawer-viewport">
      <Collapsible.Panel className="community-user-bar-drawer" inert={!open}>
        {content && cloneElement(content, { interactive: open, animate: false })}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

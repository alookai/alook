"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { cloneElement, useLayoutEffect, type ReactElement } from "react"
import { Collapsible } from "@base-ui/react/collapsible"

type Content = ReactElement<{ interactive?: boolean; animate?: boolean }>

export function UserBarExtensionDrawer({ children }: { children: Content | null }) {
  const [retained, setRetained] = useAtom(useCreateAtom(children))
  useLayoutEffect(() => {
    if (children) setRetained(children)
  }, [children, setRetained])
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

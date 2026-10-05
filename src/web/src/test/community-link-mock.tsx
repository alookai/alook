import type { ComponentProps } from "react"
import type Link from "next/link"

export function CommunityLinkMock({ href, prefetch, onNavigate, onClick, ...props }: ComponentProps<typeof Link>) {
  return <a {...props} href={String(href)} data-prefetch={String(prefetch)} onClick={(event) => {
    onClick?.(event)
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      || (props.target && props.target !== "_self") || props.download) return
    onNavigate?.({ preventDefault: () => event.preventDefault() })
  }} />
}

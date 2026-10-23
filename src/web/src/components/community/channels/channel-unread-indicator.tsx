export function ChannelUnreadIndicator({ visible, hidden = false, dot = false }: { visible: boolean; hidden?: boolean; dot?: boolean }) {
  return <span aria-hidden="true" data-slot="community-channel-unread-indicator"
    className={`pointer-events-none absolute -left-2 top-1/2 w-1 -translate-y-1/2 ${dot ? "rounded-full" : "rounded-r-full"} bg-foreground transition-all duration-150 motion-reduce:transition-none ${visible && !hidden ? dot ? "h-1" : "h-2.5" : "h-0"}`} />
}

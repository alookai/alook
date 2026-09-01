import { selectUnreadPresentation } from "@/hooks/community/unread-presentation"

export function RailIndicator({
  active,
  unread,
  testId,
}: {
  active?: boolean
  unread?: boolean
  testId?: string
}) {
  const presentation = selectUnreadPresentation({
    accountUnread: unread === true,
    active: active === true,
  })
  return (
    <span
      data-testid={testId}
      className={[
        "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-150",
        presentation.active
          ? "h-10"
          : `${presentation.showDot ? "h-2.5" : "h-0"} group-hover:h-5 group-focus-within:h-5`,
      ].join(" ")}
    />
  )
}

export function RailIndicator({
  active,
  unread,
  testId,
}: {
  active?: boolean
  unread?: boolean
  testId?: string
}) {
  return (
    <span
      data-testid={testId}
      className={[
        "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-150",
        active
          ? "h-10"
          : `${unread ? "h-2.5" : "h-0"} group-hover:h-5 group-focus-within:h-5`,
      ].join(" ")}
    />
  )
}

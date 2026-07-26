import type { ReactNode } from "react"

// Shared layout skeleton for the community "summary row" that recurs across the
// forum post card header, the right-panel thread + pinned rows, and the inbox
// unread rows: a horizontal strip of `leading` · (title / meta) · `trailing`.
//
// It renders the INNER content only (a fragment) — each call site owns its own
// interactive container (<button>, card <div>, …) and the flex classes on it,
// so the deliberately-different variants are preserved: avatar 24 vs 36, a
// leading Avatar vs EntityIcon vs AvatarGroup, a trailing count badge vs
// chevron vs avatar group. Only the leading / middle / trailing skeleton is
// shared.
//
// `meta` is optional: when omitted (e.g. the inbox row is a single title line)
// the middle wrapper is skipped and `title` is placed directly as the flex
// child, so a caller that puts `flex-1` on its title keeps its exact markup.
export function EntitySummaryCard({
  leading,
  title,
  meta,
  trailing,
}: {
  leading?: ReactNode
  title: ReactNode
  meta?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <>
      {leading}
      {meta !== undefined ? (
        <div className="min-w-0 flex-1">
          {title}
          {meta}
        </div>
      ) : (
        title
      )}
      {trailing}
    </>
  )
}

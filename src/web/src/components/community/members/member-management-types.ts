// Passed to the Members drawer when it's showing a private channel/post roster
// OR a thread's participants — the row right-click menu becomes Leave (self,
// non-creator) / Remove (viewer is the unit creator, on other explicit members)
// instead of the server-scoped Role/Kick menu. Remove is CREATOR-ONLY on every
// unit (admins have no content privilege). The creator's own row is locked.
export type MemberManageContext = {
  viewerUserId: string
  // The viewer created this unit → their own row shows no Leave (owners keep
  // the unit), and they may Remove other explicit members.
  viewerIsCreator: boolean
  // The unit's display name (channel/post/thread), used in the Leave confirm
  // dialog title ("Leave /general?"). Optional for back-compat.
  unitLabel?: string
  // Return a promise so the confirm dialog can show a loading state until the
  // remove settles. Resolved value is ignored (mutateAsync resolves to the API
  // payload) — the dialog only awaits settlement.
  onLeave: (userId: string) => Promise<unknown> | void
  onRemove: (userId: string) => Promise<unknown> | void
}

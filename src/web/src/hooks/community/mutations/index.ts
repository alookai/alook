/**
 * Barrel export for community mutation hooks. Consumers import from
 * `@/hooks/community/mutations` rather than reaching into individual files —
 * keeps the reference simple and lets us reshape the grouping without
 * churning every call site.
 */
export * from "./messages"
export * from "./friends"
export * from "./servers"
export * from "./members"
export * from "./invites"
export * from "./channels"
export * from "./forum"
export * from "./uploads"
export * from "./dm"
export * from "./folders"
export * from "./notifications"
export * from "./profile"

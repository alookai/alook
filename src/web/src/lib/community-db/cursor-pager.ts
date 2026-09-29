// Temporary replacement seam. Once @tanstack/query-db-collection publishes
// PR #1824's exact contract, replace this re-export and delete vendor/.
export { createCursorPager } from "./vendor/tanstack-query-db-create-cursor-pager"
export type {
  CursorPage,
  CursorPager,
} from "./vendor/tanstack-query-db-create-cursor-pager"

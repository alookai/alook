import type { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"

/**
 * Machines are WS-live-patched with no query refetch (see `use-machines.ts`)
 * — but that only works while THIS browser tab's own socket stays connected.
 * If the socket drops and an offline→online transition happens while it's
 * down, the event never arrives and the card is stuck stale until a full
 * page reload. Mirror `AgentProvider`'s reconnect pattern
 * (`contexts/agent-context.tsx`): resync the machines query on every
 * reconnect so a missed transition self-corrects within the reconnect
 * window instead of requiring a manual reload.
 *
 * Same rationale for the focused channel/DM message stream after Commit C:
 * the IDB persister rehydrates the cache from the last session, but the
 * socket may have dropped WS `message.create` events while we were offline
 * (or the tab was suspended). Invalidating the focused scope's message
 * query on reconnect fires a top-up refetch — TanStack re-runs every
 * page's `pageParam`, so anchor windows and newest-tail windows both
 * catch up without any client-side `?since` bookkeeping.
 *
 * Do NOT invalidate the read-state SNAPSHOT here. The snapshot hook
 * (`useChannelReadStateSnapshot`, `gcTime: 0`) latches its first resolved
 * value in a ref and deliberately never updates it during a mount — that
 * freeze is what keeps the "New" divider pinned while the watermark
 * advances. Re-fetching it can't move the divider (the ref ignores the new
 * value), but it DOES flip the hook's `isFetching` back to true, which the
 * channel/DM pages read as `lastReadMessageId: undefined` →
 * `useMessages.isLoading: true` → the whole view drops back to the loading
 * skeleton. Because `onReconnect` fires once even on a fresh page load (a
 * StrictMode / refresh double-connect makes the socket's second open run
 * it ~1.5s in), that surfaced as a SECOND skeleton flash mid-mount —
 * "skeleton → content → skeleton → scroll to the top hero" (the empty
 * round-trip also burned the message list's one-shot mount-scroll gate;
 * see `use-scroll-anchor.ts`'s re-arm-on-empty branch). Verified via live
 * Playwright page-level trace: the second skeleton window lines up exactly
 * with `readSnapshotFetching` going true at t≈1.75s. The message-query
 * invalidation below is the legitimate top-up and keeps its data on
 * screen; the divider is already correct from the first (frozen) snapshot,
 * so nothing here needs the snapshot refetched.
 */
export function reconcileCommunityWsReconnect(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: communityKeys.machines() })
  const sub = useCommunityStore.getState().subscription
  if (sub.channelId) {
    void queryClient.invalidateQueries({
      queryKey: communityKeys.channelMessages(sub.channelId),
    })
  }
  if (sub.dmConversationId) {
    void queryClient.invalidateQueries({
      queryKey: communityKeys.dmMessages(sub.dmConversationId),
    })
    // A DM message may have arrived while offline; the DM sidebar preview /
    // unread flag is only reconciled on `message.create`, none of which land
    // during the gap. Top it up on reconnect.
    void queryClient.invalidateQueries({ queryKey: communityKeys.dms() })
  }
  // Inbox counts also need a refetch — unreads and mentions could have
  // grown while offline and the live invalidator only fires on incoming
  // `message.create` events, none of which arrive while the socket is
  // down.
  void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
  // Sidebar unread dots + rail mention badges are now driven by the live
  // `unread.bump` patch (inbox-dot-ws-driven plan) — no switch-refetch backs
  // them anymore. A bump dropped during the socket gap would leave the dot /
  // rail badge stale forever, so re-seed both on reconnect: the rail LIST
  // (`servers()`, mention counts) and the open server's detail tree
  // (`server(currentServerId)`, channel dots). `exact` on the list so it
  // doesn't cascade-refetch every server's nested detail subtree.
  void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
  const currentServerId = useCommunityStore.getState().currentServerId
  if (currentServerId) {
    void queryClient.invalidateQueries({
      queryKey: communityKeys.server(currentServerId),
    })
  }
  // Bot audit logs are WS-live-patched into the React Query cache; if
  // the socket dropped, any events emitted during the gap never entered
  // the store's ring and so never made it into the cache. Invalidating
  // all bot audit-log pages on reconnect lets an open modal catch up.
  void queryClient.invalidateQueries({
    queryKey: [...communityKeys.all, "bot"],
    // Fuzzy prefix match — communityKeys.botAuditLog is [all, "bot", botId, "audit-log"].
    exact: false,
  })
}

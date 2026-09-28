import { clearAgentChatPersistenceForAccount } from "@/lib/agent-chat-persistence"
import { clearCommunityPersistenceForAccount } from "@/lib/community-db/collections"

export async function clearBrowserPersistenceForAccount(accountId: string): Promise<void> {
  const results = await Promise.allSettled([
    clearAgentChatPersistenceForAccount(accountId),
    clearCommunityPersistenceForAccount(accountId),
  ])
  const failures = results.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ))
  if (failures.length > 0) {
    console.warn("[Alook persistence] Account cache cleanup was incomplete", failures)
  }
}

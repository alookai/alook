import type { CommunityDbRegistry } from "@/lib/community-db/collections"

type CleanupAct = (callback: () => Promise<void>) => PromiseLike<unknown>

export async function retireCommunityQueryOwners(
  owners: Set<CommunityDbRegistry>,
  options: { act?: CleanupAct; timers?: Set<ReturnType<typeof setTimeout>> } = {},
) {
  const errors: unknown[] = []
  const retire = async () => {
    if (options.timers) {
      for (const timer of options.timers) {
        try { clearTimeout(timer) } catch (error) { errors.push(error) }
      }
      options.timers.clear()
    }
    try {
      for (const registry of owners) {
        try { await registry.cleanup() } catch (error) { errors.push(error) }
        try { registry.queryClient.clear() } catch (error) { errors.push(error) }
      }
    } finally {
      owners.clear()
    }
  }
  try {
    if (options.act) await options.act(retire)
    else await retire()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "Community test owner cleanup failed")
}

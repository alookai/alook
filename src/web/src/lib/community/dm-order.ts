export type DmOrderKey = {
  id: string
  activityAt?: string
}

/**
 * Preserve the original DM-list contract from the server query:
 * newest conversation activity first, then channel id ascending. Read state
 * is deliberately absent — marking a conversation read changes presentation,
 * not its position.
 */
function compareDmOrder(left: DmOrderKey, right: DmOrderKey): number {
  const activity = (right.activityAt ?? "").localeCompare(left.activityAt ?? "")
  return activity || left.id.localeCompare(right.id)
}

export function sortDmsByActivity<T extends DmOrderKey>(dms: readonly T[]): T[] {
  return [...dms].sort(compareDmOrder)
}

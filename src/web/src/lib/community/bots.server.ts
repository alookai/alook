import { tokenUsageCapability, parseCommunityBotsProfileRead, queries, DAILY_TOKEN_USAGE_WINDOW_DAYS, calendarDayKeyDaysAgo, dayKeyInTimeZone, utcDayKey, utcDayKeyDaysAgo, type Database } from "@alook/shared"
import { canonicalUserImage } from "./storage"

export function tokenUsageDayWindow(now: Date, timeZone: string | null | undefined): string[] {
  let today = utcDayKey(now)
  if (timeZone) {
    try {
      today = dayKeyInTimeZone(now, timeZone)
    } catch { }
  }
  return Array.from(
    { length: DAILY_TOKEN_USAGE_WINDOW_DAYS },
    (_, index) => calendarDayKeyDaysAgo(today, DAILY_TOKEN_USAGE_WINDOW_DAYS - 1 - index),
  )
}


export async function readCommunityBots(db: Database, userId: string) {
  const [bots, capacity] = await Promise.all([
    queries.communityBot.listBotsForOwner(db, userId),
    queries.productPlan.getBotCapacitySummary(db, userId),
  ])
  const now = new Date()
  const usageSinceDay = utcDayKeyDaysAgo(now, DAILY_TOKEN_USAGE_WINDOW_DAYS)
  const usageByBot = await queries.communityBot.getBotDailyTokenUsageForOwner(
    db,
    userId,
    usageSinceDay,
  )
  const withUsage = bots.map((bot) => {
    const { tokenUsageTimeZone, ...publicBot } = bot
    const usageDays = tokenUsageDayWindow(now, tokenUsageTimeZone)
    return {
      ...publicBot,
      image: canonicalUserImage(bot.id, bot.image, bot.avatarVersion),
      usage: {
        capability: tokenUsageCapability(bot.runtime),
        days: usageDays.map((day, index) => {
          const stored = usageByBot.get(bot.id)?.find((snapshot) => snapshot.day === day)
          return {
            day,
            period: index === usageDays.length - 1 ? "in_progress" as const : "closed" as const,
            metrics: stored?.metrics ?? {
              input: null,
              output: null,
              cache: null,
            },
          }
        }),
      },
    }
  })
  const result = {
    bots: withUsage,
    plan: capacity.plan,
    isFounder: capacity.isFounder,
    limit: capacity.limit,
    ownedCount: capacity.ownedCount,
    activeCount: capacity.activeCount,
  }
  parseCommunityBotsProfileRead(result, userId)
  return result
}

import { queries, DAILY_TOKEN_USAGE_WINDOW_DAYS, calendarDayKeyDaysAgo, dayKeyInTimeZone, utcDayKey, utcDayKeyDaysAgo, type Database } from "@alook/shared"
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
  // Attach each bot's last-30-day activity for the my-bots heatmap. One batched
  // read scoped to the owner's bots (no N+1); bots with no rows default to [].
  // The FE pads missing days to zero cells, so an empty array is the normal
  // new-bot path.
  const sinceDay = utcDayKeyDaysAgo(new Date(), 29)
  const activityByBot = await queries.communityBot.getBotDailyActivityForOwner(
    db,
    userId,
    sinceDay,
  )
  const now = new Date()
  const usageSinceDay = utcDayKeyDaysAgo(now, DAILY_TOKEN_USAGE_WINDOW_DAYS)
  const usageByBot = await queries.communityBot.getBotDailyTokenUsageForOwner(
    db,
    userId,
    usageSinceDay,
  )
  const withActivity = bots.map((bot) => {
    const { tokenUsageTimeZone, ...publicBot } = bot
    const usageDays = tokenUsageDayWindow(now, tokenUsageTimeZone)
    return {
      ...publicBot,
      image: canonicalUserImage(bot.id, bot.image, bot.avatarVersion),
      dailyActivity: activityByBot.get(bot.id) ?? [],
      usage: {
        capability: (["claude", "codex", "grok", "opencode", "pi", "antigravity", "agy"] as string[]).includes(bot.runtime)
          ? "supported" as const
          : ["cursor"].includes(bot.runtime)
            ? "unsupported" as const
            : "unknown" as const,
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
  return {
    bots: withActivity,
    plan: capacity.plan,
    isFounder: capacity.isFounder,
    limit: capacity.limit,
    ownedCount: capacity.ownedCount,
    activeCount: capacity.activeCount,
  }
}

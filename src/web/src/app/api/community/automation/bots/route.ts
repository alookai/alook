import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { createBotForUser } from "@/lib/community/create-bot.server"
export const POST = withAuth(automationPolicy("bot.create"), createBotForUser)

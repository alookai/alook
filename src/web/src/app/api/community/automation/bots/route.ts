import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { createAutomationBot } from "@/lib/community/automation-create.server"
export const POST = withAuth(automationPolicy("bot.create"), createAutomationBot)

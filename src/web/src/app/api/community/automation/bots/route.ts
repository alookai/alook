import { withAutomation } from "@/lib/automation"
import { createBotForUser } from "@/lib/community/create-bot.server"
export const POST = withAutomation("bot.create", createBotForUser)

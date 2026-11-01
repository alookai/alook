import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { sendAutomationMessage } from "@/lib/community/automation-message.server"
export const POST = withAuth(automationPolicy("message.send"), sendAutomationMessage)

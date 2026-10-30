import { withAutomation } from "@/lib/automation"
import { sendAutomationMessage } from "@/lib/community/automation-message.server"
export const POST = withAutomation("message.send", sendAutomationMessage)

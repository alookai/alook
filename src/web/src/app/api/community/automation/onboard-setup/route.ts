import { withAuth } from "@/lib/middleware/auth-policy"
import { automationSetupPolicy } from "@/lib/automation"
import { runAutomationSetup } from "@/lib/community/automation-setup.server"

export const POST = withAuth(automationSetupPolicy(), runAutomationSetup)

import { withAuth } from "@/lib/middleware/auth-policy"
import { automationSetupPolicy } from "@/lib/automation"
import { prepareAutomationSetup, runAutomationSetup } from "@/lib/community/automation-setup.server"

export const GET = withAuth(automationSetupPolicy(), prepareAutomationSetup)
export const POST = withAuth(automationSetupPolicy(), runAutomationSetup)

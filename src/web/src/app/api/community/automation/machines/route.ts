import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { readAutomationMachines } from "@/lib/community/automation-read.server"
export const GET = withAuth(automationPolicy("machine.read"), readAutomationMachines)

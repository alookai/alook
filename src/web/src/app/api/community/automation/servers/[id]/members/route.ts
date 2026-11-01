import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { readAutomationMembers } from "@/lib/community/automation-read.server"
export const GET = withAuth(automationPolicy("server.read"), readAutomationMembers)

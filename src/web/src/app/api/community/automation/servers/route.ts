import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { createAutomationServer } from "@/lib/community/automation-create.server"
import { readAutomationServers } from "@/lib/community/automation-read.server"
export const GET = withAuth(automationPolicy("server.read"), readAutomationServers)
export const POST = withAuth(automationPolicy("server.create"), createAutomationServer)

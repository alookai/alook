import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { createServerForUser } from "@/lib/community/create-server.server"
import { readAutomationServers } from "@/lib/community/automation-read.server"
export const GET = withAuth(automationPolicy("server.read"), readAutomationServers)
export const POST = withAuth(automationPolicy("server.create"), createServerForUser)

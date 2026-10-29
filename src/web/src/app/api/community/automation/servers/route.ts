import { withAutomation } from "@/lib/automation"
import { createServerForUser } from "@/lib/community/create-server.server"
import { readAutomationServers } from "@/lib/community/automation-read.server"
export const GET = withAutomation("server.read", readAutomationServers)
export const POST = withAutomation("server.create", createServerForUser)

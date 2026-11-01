import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { inviteAutomationFriend } from "@/lib/community/automation-invite.server"
export const POST = withAuth(automationPolicy("server.invite"), inviteAutomationFriend)

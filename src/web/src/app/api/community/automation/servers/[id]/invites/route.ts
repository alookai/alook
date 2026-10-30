import { withAutomation } from "@/lib/automation"
import { inviteAutomationFriend } from "@/lib/community/automation-invite.server"
export const POST = withAutomation("server.invite", inviteAutomationFriend)

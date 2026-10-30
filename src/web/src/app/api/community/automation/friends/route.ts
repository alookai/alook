import { withAutomation } from "@/lib/automation"
import { readAutomationFriends } from "@/lib/community/automation-read.server"
export const GET = withAutomation("friend.read", readAutomationFriends)

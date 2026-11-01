import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { readAutomationFriends } from "@/lib/community/automation-read.server"
export const GET = withAuth(automationPolicy("friend.read"), readAutomationFriends)

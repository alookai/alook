import { withAutomation } from "@/lib/automation"
import { readAutomationMachines } from "@/lib/community/automation-read.server"
export const GET = withAutomation("machine.read", readAutomationMachines)

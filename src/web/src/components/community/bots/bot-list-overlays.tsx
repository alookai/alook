import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AgentHelpGallery } from "@/components/community/onboarding-tiles/agent-help-gallery"
import { BotActivityModal } from "./bot-activity-modal"
import { BugReportDialog } from "./bug-report-dialog"
import { CreateBotSheet } from "./create-bot-sheet"
import { EditBotSheet } from "./edit-bot-sheet"
import type { BotListController, BotListOverlaySlots } from "./bot-list-types"

export function renderBotListOverlaySlots(
  controller: BotListController,
): BotListOverlaySlots {
  return {
    create: (
      <CreateBotSheet
        open={controller.createOpen}
        onOpenChange={controller.setCreateOpen}
        onCreated={controller.onBotCreated}
        guided={controller.guidedActive}
        avatarSeed={controller.guidedAvatarSeed}
      />
    ),
    help: (
      <AgentHelpGallery open={controller.helpOpen} onOpenChange={controller.setHelpOpen} />
    ),
    edit: (
      <EditBotSheet
        bot={controller.editingBot}
        open={controller.editOpen}
        onOpenChange={controller.setEditOpen}
      />
    ),
    activity: (
      <BotActivityModal
        bot={controller.activityBot}
        open={controller.activityOpen}
        onOpenChange={controller.onActivityOpenChange}
      />
    ),
    bug: controller.bugReportBot ? (
      <BugReportDialog
        key={controller.bugReportBot.id}
        bot={controller.bugReportBot}
        open={controller.bugReportOpen}
        onOpenChange={controller.setBugReportOpen}
      />
    ) : null,
    deleteDialog: (
      <AlertDialog
        open={!!controller.confirmDelete}
        onOpenChange={(open) => !open && controller.setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {controller.confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot will leave every server it&apos;s in and its runner key will be
              revoked. Past messages remain in history with the bot&apos;s current name
              and avatar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={controller.deleteConfirmedBot}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
    resetDialog: (
      <AlertDialog
        open={!!controller.confirmReset}
        onOpenChange={(open) => !open && controller.setConfirmReset(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset this bot&apos;s session?</AlertDialogTitle>
            <AlertDialogDescription>
              Its running process will stop and it&apos;ll start a fresh session
              that picks up unfinished work from its notes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="bot-reset-confirm"
              onClick={controller.resetConfirmedBot}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
    resetMachineDialog: (
      <AlertDialog
        open={!!controller.confirmResetMachine}
        onOpenChange={(open) => !open && controller.setConfirmResetMachine(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset all agents on {controller.confirmResetMachine
                ? controller.machineName(controller.confirmResetMachine)
                : "this machine"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every agent on this machine will start a fresh session. Any that
              aren&apos;t currently running will be woken too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="machine-reset-all-confirm"
              onClick={controller.resetConfirmedMachine}
            >
              Reset all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  }
}

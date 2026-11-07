import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { UserBarExtensionSlot } from "@/components/community/shell/user-bar-extension-slot"
import type { UserBarUpdateState } from "@/components/community/shell/user-bar-extension-state"
import { fixtureMachine } from "../../preview/machine-fixture"

const initialUpdate: UserBarUpdateState = {
  phase: "expanded",
  targetMachineIds: [fixtureMachine.id],
  acceptedMachineIds: [],
  failedMachineIds: [],
  pendingMachineIds: [],
}

const meta = {
  title: "Web/Business/User bar machine update",
  component: UserBarExtensionSlot,
  tags: ["autodocs", "ai-generated"],
  args: {
    active: "update",
    update: initialUpdate,
    eligibleMachines: [fixtureMachine],
    onDismiss: fn(),
    onRequestUpdate: fn(),
    animate: false,
    focusOnOpen: false,
  },
  decorators: [(Story) => <div className="max-w-sm"><Story /></div>],
  parameters: { docs: { description: { component: "Original user-bar slot and update panel with typed local machine states. Buttons record Actions; no machine update is sent. These snapshots do not simulate daemon progress." } } },
} satisfies Meta<typeof UserBarExtensionSlot>
export default meta
type Story = StoryObj<typeof meta>
export const Available: Story = {}
export const Updating: Story = { args: { update: { ...initialUpdate, phase: "updating", pendingMachineIds: [fixtureMachine.id] } } }
export const Retry: Story = { args: { update: { ...initialUpdate, phase: "retry", failedMachineIds: [fixtureMachine.id] } } }

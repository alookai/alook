import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

const meta = {
  title: "Web/Foundations/Checkbox",
  component: Checkbox,
  tags: ["autodocs", "ai-generated"],
  args: { defaultChecked: true, onCheckedChange: fn() },
  render: (args) => (
    <div className="grid gap-2">
      <Label>
        <Checkbox {...args} />
        Web
      </Label>
      <Label>
        <Checkbox defaultChecked={false} onCheckedChange={args.onCheckedChange} />
        Desktop
      </Label>
    </div>
  ),
} satisfies Meta<typeof Checkbox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Disabled: Story = { args: { disabled: true } }

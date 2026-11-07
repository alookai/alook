import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Button } from "../../../web/src/components/ui/button"

const meta = {
  title: "Web/Foundations/Button",
  component: Button,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "centered", docs: { description: { component: "The product Button, with its existing variants and sizes. Change the inputs in Controls and inspect actions without a backend." } } },
  argTypes: {
    variant: { control: "select", options: ["default", "outline", "secondary", "ghost", "destructive", "link"] },
    size: { control: "select", options: ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] },
    children: { control: "text" },
    disabled: { control: "boolean" },
  },
  args: { children: "Create channel", variant: "default", size: "default", disabled: false, onClick: fn() },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {}
export const Outline: Story = { args: { variant: "outline", children: "Preview changes" } }
export const Disabled: Story = { args: { disabled: true, children: "Waiting for permission" } }
export const LongLabel: Story = { args: { children: "Create a channel for the next shared project" } }

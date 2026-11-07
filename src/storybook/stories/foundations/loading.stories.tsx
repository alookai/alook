import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { AlookLoading } from "@/components/brand/alook-loading/AlookLoading"

const meta = { title: "Web/Foundations/Alook loading", component: AlookLoading, tags: ["autodocs", "ai-generated"], args: { size: 96, paused: false, label: "Loading conversation" }, argTypes: { size: { control: { type: "range", min: 32, max: 256, step: 16 } } } } satisfies Meta<typeof AlookLoading>
export default meta
type Story = StoryObj<typeof meta>
export const Animated: Story = {}
export const Paused: Story = { args: { paused: true } }

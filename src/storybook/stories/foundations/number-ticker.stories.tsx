import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { NumberTicker } from "@/components/ui/number-ticker"

const meta = { title: "Web/Foundations/Number ticker", component: NumberTicker, tags: ["autodocs", "ai-generated"], args: { value: 1234, decimals: 0, compact: false, duration: 400 }, argTypes: { value: { control: "number" }, decimals: { control: { type: "range", min: 0, max: 4, step: 1 } } } } satisfies Meta<typeof NumberTicker>
export default meta
type Story = StoryObj<typeof meta>
export const Integer: Story = {}
export const Compact: Story = { args: { value: 4200, compact: true } }
export const Fraction: Story = { args: { value: 0.75, decimals: 2 } }
export const Zero: Story = { args: { value: 0 } }

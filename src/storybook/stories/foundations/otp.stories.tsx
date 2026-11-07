import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { useArgs } from "storybook/preview-api"
import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from "@/components/ui/input-otp"

function VerificationCode({ disabled = false, value = "", onChange }: { disabled?: boolean; value?: string; onChange?: (value: string) => void }) {
  return <InputOTP maxLength={6} aria-label="Verification code" disabled={disabled} value={value} onChange={onChange}><InputOTPGroup>{[0, 1, 2].map((index) => <InputOTPSlot key={index} index={index} />)}</InputOTPGroup><InputOTPSeparator /><InputOTPGroup>{[3, 4, 5].map((index) => <InputOTPSlot key={index} index={index} />)}</InputOTPGroup></InputOTP>
}
const meta = { title: "Web/Foundations/One-time code", component: VerificationCode, tags: ["autodocs", "ai-generated"], args: { value: "", disabled: false, onChange: fn() }, render: function Render(args) {
  const [{ value }, updateArgs] = useArgs<{ value: string }>()
  return <VerificationCode {...args} value={value} onChange={(next) => { updateArgs({ value: next }); args.onChange?.(next) }} />
} } satisfies Meta<typeof VerificationCode>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {}
export const Filled: Story = { args: { value: "123456" } }
export const Disabled: Story = { args: { disabled: true } }

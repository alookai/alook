import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { MessageNotificationToaster, messageNotification } from "@/components/ui/toast"
import { Button } from "@/components/ui/button"
import { ToasterProvider } from "@/components/toaster-provider"
import { toast } from "sonner"

function ToastExample() { return <><MessageNotificationToaster /><ToasterProvider /><div className="flex flex-wrap gap-3">{["success", "warning", "error", "info"].map((type) => <Button key={type} variant="outline" onClick={() => messageNotification.add({ type, title: type === "error" ? "Could not send" : "Preview notification", description: "This is the actual product notification component.", timeout: 5000 })}>{type}</Button>)}<Button onClick={() => toast.success("Saved locally in the preview")}>Sonner notification</Button></div></> }
const meta = { title: "Web/Foundations/Notifications", component: ToastExample, tags: ["autodocs", "ai-generated"] } satisfies Meta<typeof ToastExample>
export default meta
type Story = StoryObj<typeof meta>
export const Trigger: Story = {}

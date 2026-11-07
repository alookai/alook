import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { useState } from "react"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { DaemonUpdateNotice, daemonUpdateStorageKey } from "@/components/daemon-update-notice"
import { MessageNotificationToaster } from "@/components/ui/toast"
import { Button } from "@/components/ui/button"
import { fixtureMachine } from "../../preview/machine-fixture"

function NoticeExample({ onUpdate }: { onUpdate: (id: string) => void }) { const [revision, setRevision] = useState(0); const userId = "storybook-preview-update"; return <BusinessFixtures><MessageNotificationToaster /><Button onClick={() => { localStorage.removeItem(daemonUpdateStorageKey(userId)); setRevision((value) => value + 1) }}>Show update notice</Button>{revision > 0 && <DaemonUpdateNotice key={revision} userId={userId} webVersion="0.1.65" latestDaemonVersion="0.1.66" loadMachines={async () => ({ machines: [fixtureMachine], complete: true })} requestUpdate={async (id) => { onUpdate(id) }} />}</BusinessFixtures> }
const meta = { title: "Web/Business/Machine update notice", component: NoticeExample, tags: ["ai-generated"], args: { onUpdate: fn() }, parameters: { docs: { description: { component: "Original notice and notification UI with its supported local load/update callbacks. Update only records an Action; no daemon is contacted." } } } } satisfies Meta<typeof NoticeExample>
export default meta
type Story = StoryObj<typeof meta>
export const OpenNotice: Story = {}

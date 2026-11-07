import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { InviteAcceptClient } from "@/app/(public-community)/c/invite/[token]/invite-accept-client"

const meta = { title: "Web/Pages/Invitation", component: InviteAcceptClient, tags: ["ai-generated"], args: { token: "storybook-preview" }, parameters: { docs: { description: { component: "Original public invitation view. The server preview is a local fixture; join/auth operations are not real account writes." } } } } satisfies Meta<typeof InviteAcceptClient>
export default meta
type Story = StoryObj<typeof meta>
export const Preview: Story = {}
export const Expired: Story = { args: { token: "storybook-expired" } }
export const Unavailable: Story = { args: { token: "storybook-unavailable" } }

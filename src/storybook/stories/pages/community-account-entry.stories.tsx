import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { CommunityAccountPendingFrame } from "@/components/community/shell/community-account-pending-frame"
import { Button } from "@/components/ui/button"

const meta = { title: "Web/Pages/Community account entry", tags: ["ai-generated"], parameters: { layout: "fullscreen", docs: { description: { component: "Original public account loading and error frames. These local visual fixtures do not start authentication, restore private cache or verify a retry interaction." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Loading: Story = { render: () => <BusinessFixtures><CommunityAccountPendingFrame pathname="/c" /></BusinessFixtures> }
export const AccountError: Story = { render: () => <BusinessFixtures><CommunityAccountPendingFrame pathname="/c/me">
  <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8" role="alert"><p>Couldn&apos;t check your account.</p><Button variant="outline">Retry</Button></div>
</CommunityAccountPendingFrame></BusinessFixtures> }

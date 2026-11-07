import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { AppComponents } from "@/app/brand-visual/app-components"
import { AppBotsSpecimens } from "@/app/brand-visual/app-bots"
import { AppPeopleSpecimens } from "@/app/brand-visual/app-people"
import { AppOnboardingSpecimens } from "@/app/brand-visual/app-onboarding"
import { AppSettingsSpecimens } from "@/app/brand-visual/app-settings"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"

const meta = {
  title: "Web/Business/Product compositions",
  tags: ["ai-generated"],
  parameters: { layout: "fullscreen", docs: { description: { component: "Existing product specimens with their actual seeded Query/Community DB owners. Each section identifies its local actions. This previews components, without a signed-in application or real account writes." } } },
  decorators: [(Story) => <CommunityPreviewNavigation value={true}><Story /></CommunityPreviewNavigation>],
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const ChannelsMessagesAndComposer: Story = { render: () => <AppComponents /> }
export const BotsModelsAndPrivacy: Story = { render: (_, context) => <AppBotsSpecimens mode={context.globals.theme === "dark" ? "dark" : "light"} /> }
export const FriendsProfilesAndApprovals: Story = { render: (_, context) => <AppPeopleSpecimens mode={context.globals.theme === "dark" ? "dark" : "light"} /> }
export const OnboardingMachinesAndBilling: Story = { render: (_, context) => <AppOnboardingSpecimens mode={context.globals.theme === "dark" ? "dark" : "light"} /> }
export const UserAndServerSettings: Story = { render: (_, context) => <AppSettingsSpecimens accountId="demo-gus" mode={context.globals.theme === "dark" ? "dark" : "light"} /> }

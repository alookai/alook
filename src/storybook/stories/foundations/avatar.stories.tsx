import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Avatar, AvatarImage, AvatarFallback, AvatarBadge, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { AgentAvatar } from "@/components/avatar/agent-avatar"
import { AnimatedAvatar } from "@/components/avatar/animated-avatar"
import { ProfileAvatar } from "@/components/avatar/profile-avatar"
import { GeneratedAvatar } from "@/components/avatar/generated-avatar"
import { SeededBackdrop } from "@/components/avatar/seeded-backdrop"
import { Avatar as CommunityAvatar } from "@/components/community/avatar"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"

function AvatarExamples({ seed = "demo-alli", size = 48, working = false, hovered = false }: { seed?: string; size?: number; working?: boolean; hovered?: boolean }) { return <div className="flex flex-wrap items-center gap-6"><AgentAvatar seed={seed} name="Alli" size={size} /><GeneratedAvatar seed={seed} size={size} /><AnimatedAvatar seed={seed} size={size} isHovered={hovered} isWorking={working} /><ProfileAvatar label="Gus" src={LANDING_HUMAN_AVATARS.gus} size={size} /><CommunityAvatar label="Alli" seed={seed} size={size} presence="online" /><AvatarGroup><Avatar><AvatarImage src={LANDING_HUMAN_AVATARS.gus} alt="Gus" /><AvatarFallback>G</AvatarFallback><AvatarBadge /></Avatar><Avatar><AvatarFallback>S</AvatarFallback></Avatar><AvatarGroupCount>+3</AvatarGroupCount></AvatarGroup><div className="relative size-20 overflow-hidden rounded-lg"><SeededBackdrop seed={seed} /></div></div> }
const meta = { title: "Web/Foundations/Avatars", component: AvatarExamples, tags: ["autodocs", "ai-generated"], args: { seed: "demo-alli", size: 48, working: false, hovered: false }, argTypes: { size: { control: { type: "range", min: 24, max: 96, step: 8 } } } } satisfies Meta<typeof AvatarExamples>
export default meta
type Story = StoryObj<typeof meta>
export const Identities: Story = {}
export const Working: Story = { args: { working: true } }
export const Hovered: Story = { args: { hovered: true } }

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useRef } from "react"
import { CloudCodeMonsterPet, CloudCodeMonsterPresetPreview, CLOUD_CODE_MONSTER_PET_PRESETS } from "@/components/home-pet/cloud-code-monster-pet"

function PetExample({ inboxCount = 0, activeAgentTaskCount = 0 }: { inboxCount?: number; activeAgentTaskCount?: number }) { const boundary = useRef<HTMLDivElement>(null); return <div ref={boundary} className="relative h-128 overflow-hidden rounded-xl border border-border"><p className="p-4 text-sm text-muted-foreground">The actual home pet stays inside this preview boundary.</p><button type="button" data-pet-target-id="inbox" className="absolute left-8 top-20 rounded-lg border border-border px-3 py-2 text-sm">Inbox</button><CloudCodeMonsterPet coordinateSpace="boundary" boundaryRef={boundary} inboxCount={inboxCount} activeAgentTaskCount={activeAgentTaskCount} initialPosition={{ x: 100, y: 100 }} /></div> }
const meta = { title: "Web/Business/Home pet", component: PetExample, tags: ["ai-generated"], args: { inboxCount: 0, activeAgentTaskCount: 0 } } satisfies Meta<typeof PetExample>
export default meta
type Story = StoryObj<typeof meta>
export const Idle: Story = {}
export const Working: Story = { args: { activeAgentTaskCount: 2 } }
export const Unread: Story = { args: { inboxCount: 3 } }
export const Presets: Story = { render: () => <div className="flex flex-wrap gap-6">{CLOUD_CODE_MONSTER_PET_PRESETS.map((preset) => <CloudCodeMonsterPresetPreview key={preset.id} preset={preset} className="size-32" />)}</div> }

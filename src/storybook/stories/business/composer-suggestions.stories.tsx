import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useRef, useState } from "react"
import { fn } from "storybook/test"
import { CommunityMentionList, ChannelRefList } from "@/components/community/messages/composer-suggestion-popups"
import { Button } from "@/components/ui/button"
import type { MentionItem } from "@/lib/community/mention-extension"
import type { ChannelRefCandidate } from "@/lib/community/channel-ref-extension"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { fixtureProfiles } from "../../preview/read-fixtures"

const member = fixtureProfiles.find((profile) => profile.id === "demo-alli")!
const mentions: MentionItem[] = [
  { kind: "everyone", id: "everyone", label: "everyone" },
  { kind: "member", id: "demo-alli", userId: "demo-alli", label: `${member.name}#${member.discriminator}`, name: member.name, discriminator: member.discriminator, avatar: member.avatar ?? "Alli", status: "online" },
]
const channels: ChannelRefCandidate[] = [{ id: "demo-general", name: "general", serverId: "demo-studio", serverName: "Studio", serverDiscriminator: "4012" }]

function SuggestionExample({ kind = "mentions", status = "ready", onSelect }: { kind?: "mentions" | "channels"; status?: "ready" | "loading" | "empty" | "error"; onSelect: (value: unknown) => void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const getRect = () => anchor.current?.getBoundingClientRect() ?? null
  const command = open ? (value: unknown) => { onSelect(value); setOpen(false) } : null
  return <BusinessFixtures><div className="flex min-h-80 items-start gap-2 p-4"><Button ref={anchor} onClick={() => setOpen(true)}>Open {kind}</Button><Button variant="outline" onClick={() => setOpen(false)}>Close suggestions</Button>{kind === "mentions" ? <CommunityMentionList state={{ items: status === "ready" ? mentions : [], query: "", selectedIndex: 0, command, getRect }} presentation={{ status }} /> : <ChannelRefList state={{ items: status === "ready" ? channels : [], selectedIndex: 0, command, getRect }} presentation={{ status }} />}</div></BusinessFixtures>
}

const meta = { title: "Web/Business/Composer suggestions", component: SuggestionExample, tags: ["autodocs", "ai-generated"], args: { kind: "mentions", status: "ready", onSelect: fn() }, argTypes: { kind: { control: "select", options: ["mentions", "channels"] }, status: { control: "select", options: ["ready", "loading", "empty", "error"] } }, parameters: { docs: { description: { component: "Original anchored popup views and rows with supported local candidates and status inputs. Selection records an Action. The real product composer remains available in Product compositions; this focused view does not simulate an editor or send messages." } } } } satisfies Meta<typeof SuggestionExample>
export default meta
type Story = StoryObj<typeof meta>
export const Mentions: Story = {}
export const ChannelReferences: Story = { args: { kind: "channels" } }
export const Loading: Story = { args: { status: "loading" } }
export const Empty: Story = { args: { status: "empty" } }
export const Unavailable: Story = { args: { status: "error" } }

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { PaperSticker } from "@/components/brand/paper-sticker"
import { HandAccent } from "@/components/brand/hand-accent"
import { Mac, CdPlayer, Cassette, FlipPhone } from "@/components/brand/retro-objects"
import { Logo } from "@/components/logo"
import { ProviderLogo } from "@/components/provider-logo"

function BrandExamples({ tilt = -4, label = "hello" }: { tilt?: number; label?: string }) { return <div className="flex flex-col gap-8"><Logo /><h2 className="text-3xl">People and <HandAccent>agents</HandAccent></h2><div className="flex flex-wrap items-end gap-8"><Mac label={label} /><CdPlayer /><Cassette /><FlipPhone /><PaperSticker tilt={tilt}><span className="inline-block p-4 font-medium">Alook</span></PaperSticker></div><div className="flex flex-wrap gap-4">{["claude", "codex", "opencode", "openclaw", "hermes", "pi", "qoder", "copilot", "cursor", "gemini", "antigravity", "kimi", "grok", "unknown"].map((provider) => <span key={provider} title={provider}><ProviderLogo provider={provider} className="size-8" /></span>)}</div></div> }
const meta = { title: "Web/Foundations/Brand artwork", component: BrandExamples, tags: ["autodocs", "ai-generated"], args: { tilt: -4, label: "hello" }, parameters: { docs: { description: { component: "Actual product artwork. Storybook toolbar owns the forced theme; the Logo's product theme request cannot override that preview setting." } } } } satisfies Meta<typeof BrandExamples>
export default meta
type Story = StoryObj<typeof meta>
export const ObjectsAndMarks: Story = {}

"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { Mac, CdPlayer, Cassette, FlipPhone } from "@/components/brand/retro-objects"
import { ArrowRight, Inbox, Mail, Plus, Settings, Users, X } from "lucide-react"
import { SiGithub, SiGoogle } from "@icons-pack/react-simple-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Kbd } from "@/components/ui/kbd"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Avatar as AppAvatar } from "@/components/community/avatar"
import { ProfileCard } from "@/components/community/social/profile-card"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import type { CommunityProfile } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import tn from "@/components/brand/technostalgia.module.css"
import { useTheme } from "next-themes"
import { PaperStickerSpecimen } from "./paper-sticker-specimen"
import { AppComponents, FeatureMessages } from "./app-components"
import { AppSettingsSpecimens } from "./app-settings"
import { AppBotsSpecimens } from "./app-bots"
import { AppPeopleSpecimens } from "./app-people"
import { AppOnboardingSpecimens } from "./app-onboarding"
import s from "./brand-visual.module.css"

const PALETTE = [
  ["Grid paper", "#faf6ee"],
  ["Grid line", "#bcd6e6"],
  ["Plastic", "#d0c0a5"],
  ["Plastic side", "#b9a67e"],
  ["CD blue", "#5f8bcf"],
  ["Blue side", "#34588f"],
  ["Screen", "#d8e7ea"],
  ["Ink", "#1f1a15"],
  ["Walkman orange", "#e38b32"],
  ["Sage", "#6f9a72"],
] as const

const DARK_PALETTE = [
  ["Night", "#0a0b10"],
  ["Graphite", "#141822"],
  ["Line", "#2c3242"],
  ["Device plastic", "#aec4d2"],
  ["Plastic side", "#7d93a3"],
  ["Key blue", "#5171cd"],
  ["Blue side", "#2f4aa0"],
  ["Screen", "#6b92b6"],
  ["Coral", "#e8806f"],
  ["Text", "#e4eaf2"],
] as const

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className={s.section}>
      <div className={s.sectionHead}><h2>{title}</h2>{note ? <p>{note}</p> : null}</div>
      {children}
    </section>
  )
}

function Panel({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <Card className={`gap-0 p-6 ${className ?? ""}`}>
      <p className={s.panelLabel}>{label}</p>
      {children}
    </Card>
  )
}

/** Reuses the real community Avatar; only the "working" ring is board-specific. */
function Person({ initial, bot, working, online }: { initial: string; bot?: boolean; working?: boolean; online?: boolean }) {
  return (
    <span className={s.person2} data-working={working || undefined} data-bot={bot || undefined}>
      <AppAvatar label={initial} seed={`${bot ? "bot" : "person"}-${initial}`} size={40} presence={online ? "online" : undefined} />
    </span>
  )
}

function Objects() {
  return (
    <div className={s.objects}>
      <Mac className={s.obj} style={{ left: "18%", top: "2%", width: "58%" }} />
      <CdPlayer className={s.obj} style={{ left: "0%", bottom: "0%", width: "38%", transform: "rotate(-8deg)" }} />
      <Cassette className={s.obj} style={{ right: "0%", bottom: "6%", width: "34%", transform: "rotate(7deg)" }} />
      <FlipPhone className={s.obj} style={{ right: "4%", top: "0%", width: "13%", transform: "rotate(12deg)" }} />
      <span className={`${s.tag} ${s.tagOrange} ${s.stickerFloat}`} style={{ left: "4%", top: "10%", ["--tilt" as string]: "-8deg" }}>3 agents online</span>
      <span className={`${s.tag} ${s.tagBlue} ${s.stickerFloat}`} style={{ right: "10%", top: "48%", ["--tilt" as string]: "6deg" }}>since 1984*</span>
    </div>
  )
}

const PEOPLE = [
  { id: "gus", name: "Gus", avatar: LANDING_HUMAN_AVATARS.gus, about: "I build Alook with a small team of people and agents.", status: "Shipping the new look", presence: "online" as const, bot: false },
  { id: "alli", name: "Alli", avatar: "Alli", about: "Gus’s design agent. I keep the brand in one piece.", status: "Working on it", presence: "online" as const, bot: true },
  { id: "tracy", name: "Tracy", avatar: LANDING_HUMAN_AVATARS.tracy, about: "Product, mostly on my phone.", status: "", presence: "offline" as const, bot: false },
  { id: "cecilia", name: "Cecilia", avatar: "Cecilia", about: "I review code and support replies.", status: "", presence: "offline" as const, bot: true },
]

const PREVIEW_PROFILES = new Map<string, CommunityProfile>(PEOPLE.map((p) => [p.id, { id: p.id, name: p.name, avatar: p.avatar, aboutMe: p.about, presence: p.presence, statusText: p.status || undefined }]))

function AvatarStudio() {
  const [open, setOpen] = useState("gus")
  const person = PEOPLE.find((p) => p.id === open) ?? PEOPLE[0]
  return (
    <CommunityPreviewProfileOwner profiles={PREVIEW_PROFILES}>
      <div className={s.avatarStudio}>
        <Card className="gap-6 p-6">
          <p className={s.panelLabel}>Sizes · 24 / 32 / 40 / 64</p>
          <div className={s.row} style={{ alignItems: "end", gap: 20 }}>
            {[24, 32, 40, 64].map((size) => <AppAvatar key={size} label={PEOPLE[0].avatar} seed="gus" size={size} presence="online" ringColor="var(--card)" />)}
          </div>
          <p className={s.panelLabel}>People and agents · click one</p>
          <div className={s.row} style={{ gap: 18 }}>
            {PEOPLE.map((p) => (
              <button key={p.id} type="button" className={s.avatarKey} data-on={open === p.id} data-bot={p.bot || undefined} onClick={() => setOpen(p.id)} aria-label={`Open ${p.name}’s profile`}>
                <AppAvatar label={p.avatar} seed={p.id} size={48} presence={p.presence} ringColor="var(--card)" />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
          <p className={s.hint}>Presence is a dot cut out of the avatar. Click to open the real profile card.</p>
        </Card>
        <div className={s.profileStage}>
          <div key={person.id} className={s.profileIn}>
            <ProfileCard embedded data={{ name: person.name, userId: person.id, avatar: person.avatar, contextLabel: person.bot ? "Agent" : "Member", about: person.about, mutual: 0, presence: person.presence }} x={0} y={0} bp="desktop" onClose={() => undefined} initialStatusText={person.status || undefined} />
          </div>
        </div>
      </div>
    </CommunityPreviewProfileOwner>
  )
}

const FAQ = [
  ["What is Alook?", "A shared room where your team, friends and coding agents work together."],
  ["Will my agent keep working while I’m away?", "Yes. It runs on your own machine and replies in the room."],
  ["Who can see my conversations?", "Only people and agents you invite."],
]

const AGENTS = [["claude", "Claude Code", "✳"], ["codex", "Codex", "◎"], ["cursor", "Cursor", "▲"], ["opencode", "OpenCode", "□"]] as const

function Sticker({ children, tone = "outline", tilt = -3, style }: { children: ReactNode; tone?: "default" | "secondary" | "outline"; tilt?: number; style?: CSSProperties }) {
  return <Badge variant={tone} style={{ rotate: `${tilt}deg`, ...style }}>{children}</Badge>
}

/** The board renders real components. Block every write to the API so a
 * specimen can never create a real pair key, bot, server or access code. */
function useBoardWriteGuard() {
  useEffect(() => {
    const original = window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      if (method !== "GET" && method !== "HEAD" && /\/api\//.test(url)) {
        // Fail like an offline request, which every specimen already handles.
        return Promise.reject(new TypeError("Failed to fetch (writes are disabled on /brand-visual)"))
      }
      return original(input, init)
    }
    return () => { window.fetch = original }
  }, [])
}

export function BrandVisual() {
  useBoardWriteGuard()
  const [openFaq, setOpenFaq] = useState(0)
  const [agent, setAgent] = useState("claude")
  const [otp, setOtp] = useState("481")
  // The board's switch is the app's own theme switch (the theme is global now).
  // Server render has no theme; render light until mounted so hydration matches,
  // then follow the resolved app theme.
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const mode: "light" | "dark" = mounted && resolvedTheme === "dark" ? "dark" : "light"
  const setMode = (next: "light" | "dark") => setTheme(next)

  return (
    <main className={`${tn.theme} ${tn.grid} ${s.page}`} data-tn-mode={mode}>
      <div className={s.modeToggle}>
        <Tabs value={mode} onValueChange={(v) => setMode(v as "light" | "dark")}>
          <TabsList>
            <TabsTrigger value="light">Light</TabsTrigger>
            <TabsTrigger value="dark">Dark</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className={s.wrap}>
        <header className={s.intro}>
          <Sticker tone="secondary">brand visual · A1</Sticker>
          <h1>Alook <span className={s.hand}>technostalgia</span></h1>
          <p>Beige plastic and CD blue on grid paper, with quiet hairline edges. Built from our real shadcn components.</p>
        </header>

        <PaperStickerSpecimen />

        <Section title="Foundations">
          <div className={s.swatches}>
            {(mode === "dark" ? DARK_PALETTE : PALETTE).map(([name, hex]) => (
              <div key={name} className={s.swatch}><span style={{ background: hex }} /><b>{name}</b><code>{hex}</code></div>
            ))}
          </div>
          <Panel label="Type">
            <div className={s.typeRow}><span>Display</span><div className={s.display}>Team and <span className={s.hand}>Friends</span></div></div>
            <div className={s.typeRow}><span>Title</span><div className={s.title}>Connect your agent</div></div>
            <div className={s.typeRow}><span>Body</span><div>Chat with your team, friends, and agents in one place.</div></div>
            <div className={s.typeRow}><span>Meta</span><div className={s.mono} style={{ fontSize: 12, color: "var(--tn-muted)" }}>Aug 6, 12:21 PM · #general</div></div>
          </Panel>
        </Section>

        <Section title="Avatar and profile" note="Click an avatar">
          <AvatarStudio />
        </Section>

        <Section title="Buttons" note="Press one">
          <Panel label="Button variants">
            <div className={s.row}>
              <Button size="lg">Get started <ArrowRight /></Button>
              <Button size="lg" variant="secondary">View on GitHub</Button>
              <Button size="lg" variant="outline">Invite</Button>
              <Button size="lg" variant="ghost">Change agent</Button>
              <Button size="lg" variant="destructive">Leave server</Button>
              <Button size="icon-lg" variant="secondary" aria-label="Settings"><Settings /></Button>
              <Button size="icon-lg" variant="ghost" aria-label="Close"><X /></Button>
              <Button size="lg" disabled>Disabled</Button>
            </div>
            <div className={s.row} style={{ marginTop: 20 }}>
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">Large</Button>
            </div>
          </Panel>
        </Section>

        <Section title="Forms">
          <div className={s.grid3}>
            <Panel label="Input · Field">
              <div className={s.fieldStack}>
                <Field><FieldLabel>Email</FieldLabel><Input placeholder="you@example.com" /></Field>
                <Field><FieldLabel>Channel name</FieldLabel><Input defaultValue="design-review" /><FieldDescription>Lowercase, no spaces.</FieldDescription></Field>
                <Field data-invalid><FieldLabel>Bot name</FieldLabel><Input defaultValue="alli" aria-invalid /><FieldError>That name is taken.</FieldError></Field>
              </div>
            </Panel>
            <Panel label="Switch · RadioGroup">
              <div className={s.checks}>
                <label className={s.check}><Switch defaultChecked />Keep daemon running</label>
                <label className={s.check}><Switch />Share typing status</label>
                <Separator className="my-2" />
                <RadioGroup defaultValue="everyone">
                  <label className={s.check}><RadioGroupItem value="everyone" />Everyone can join</label>
                  <label className={s.check}><RadioGroupItem value="invite" />Invite only</label>
                </RadioGroup>
              </div>
            </Panel>
            <Panel label="InputOTP · Textarea">
              <div className={s.fieldStack}>
                <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                  <InputOTPGroup>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}</InputOTPGroup>
                </InputOTP>
                <Textarea placeholder="Describe what the bot should do" />
              </div>
            </Panel>
          </div>
        </Section>

        <Section title="Status">
          <div className={s.grid3}>
            <Panel label="Badge · Avatar">
              <div className={s.row} style={{ marginBottom: 12 }}>
                <Sticker tone="outline" tilt={-4}><i className={s.dot} />Online</Sticker>
                <Sticker tone="default" tilt={3}>Working</Sticker>
                <Sticker tone="secondary" tilt={-2}>design</Sticker>
              </div>
              <div className={s.row}>
                <Person initial="G" online />
                <Person initial="A" bot working online />
                <Person initial="T" />
                <Person initial="C" bot />
              </div>
            </Panel>
            <Panel label="Skeleton · Kbd">
              <div className={s.fieldStack}>
                <Skeleton className="h-3 w-3/4 rounded-full" /><Skeleton className="h-3 w-full rounded-full" /><Skeleton className="h-3 w-1/2 rounded-full" />
                <div className={s.row}><Kbd>⌘</Kbd><Kbd>K</Kbd><span className={s.hint}>Search everything</span></div>
              </div>
            </Panel>
            <Panel label="Empty state">
              <div className={s.empty}>
                <Inbox size={28} strokeWidth={1.75} />
                <h3>Nothing new</h3>
                <p>Mentions and replies show up here.</p>
                <Button variant="secondary" size="sm">Open a channel</Button>
              </div>
            </Panel>
          </div>
        </Section>

        <Section title="Overlays" note="Dialog and DropdownMenu, opened for real">
          <div className={s.row}>
            <Dialog>
              <DialogTrigger render={<Button variant="secondary" size="lg">Open setup dialog</Button>} />
              <DialogContent className={tn.theme} data-tn-mode={mode}>
                <DialogHeader>
                  <div className={s.steps}><i data-on="true" /><i /><i /></div>
                  <DialogTitle>Which agent do you use?</DialogTitle>
                  <DialogDescription>We’ll connect it to your room.</DialogDescription>
                </DialogHeader>
                <RadioGroup value={agent} onValueChange={(v) => setAgent(String(v))} className="gap-2">
                  {AGENTS.map(([id, name, glyph]) => (
                    <label key={id} className={s.option} data-on={agent === id}><span className={s.agentIcon}>{glyph}</span>{name}<RadioGroupItem value={id} className="ml-auto" /></label>
                  ))}
                </RadioGroup>
                <DialogFooter><Button variant="ghost">Exit setup</Button><Button>Continue</Button></DialogFooter>
              </DialogContent>
            </Dialog>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="lg">Server menu</Button>} />
              <DropdownMenuContent className={tn.theme} data-tn-mode={mode}>
                <DropdownMenuItem><Users />Invite people<DropdownMenuShortcut>⌘I</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem><Settings />Server settings</DropdownMenuItem>
                <DropdownMenuItem><Mail />Mark as read</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive"><X />Leave server</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Section>

        <Section title="Landing page">
          <Card className={`${s.hero2} ${tn.paper} p-0`}>
            <div className={s.heroCopy}>
              <h3>Multi-Agent Collaboration for <span className={s.hand}>Team and Friends</span></h3>
              <p>Your team, friends and agents. One room.</p>
              <div className={s.row}>
                <Button size="lg">Get started <ArrowRight /></Button>
                <Button size="lg" variant="secondary"><SiGithub />View on GitHub</Button>
              </div>
            </div>
            <div className={s.heroArt}><div className={`${s.screen} ${tn.halftone}`} /><Objects /></div>
          </Card>
          <Card className="p-6">
            <Tabs defaultValue="collab">
              <TabsList>
                {[["collab", "Collaboration"], ["local", "Free and local"], ["remote", "Remote control"], ["identity", "Agent identity"], ["memory", "Memory"]].map(([v, l]) => <TabsTrigger key={v} value={v}>{l}</TabsTrigger>)}
              </TabsList>
            </Tabs>
            <div className={s.feature} style={{ marginTop: 28 }}>
              <div>
                <h4>Chat with shared agents</h4>
                <p>Bring your agent into the group chat.</p>
                <Button size="lg">Share your agent</Button>
              </div>
              <Card className="gap-0 overflow-hidden p-0">
                <div className={s.windowBar}><i /><i /><i /><span>#general</span></div>
                <FeatureMessages />
              </Card>
            </div>
          </Card>
          <div className={s.grid2}>
            <div className={s.faq}>
              {FAQ.map(([q, a], i) => (
                <div key={q} className={s.faqItem} data-open={openFaq === i}>
                  <button className={s.faqQ} onClick={() => setOpenFaq(openFaq === i ? -1 : i)}><span>{q}</span><span><Plus size={14} /></span></button>
                  {openFaq === i ? <p className={s.faqA}>{a}</p> : null}
                </div>
              ))}
            </div>
            <Card className={`${s.closing2} ${tn.halftone}`}>
              <h3>Bring your team into the <span className={s.hand}>conversation</span></h3>
              <Button size="lg">Get started <ArrowRight /></Button>
            </Card>
          </div>
        </Section>

        <Section title="Sign-in">
          <div className={`${s.signinStage} ${tn.grid}`}>
            <Card className="w-full max-w-md gap-4 p-7">
              <CardHeader className="p-0"><CardTitle className="text-2xl">Welcome to <span className={s.hand}>Alook</span></CardTitle><CardDescription>Pick the way you sign in.</CardDescription></CardHeader>
              <CardContent className="grid gap-3 p-0">
                <Button size="lg" variant="secondary" className="justify-start"><SiGithub />Continue with GitHub</Button>
                <Button size="lg" variant="secondary" className="justify-start"><SiGoogle />Continue with Google</Button>
                <Input placeholder="you@example.com" />
                <Button size="lg">Continue with email</Button>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section title="App">
          <p className={s.hint}>The whole workspace first: the real /demo app in this style. Click channels, send a message, open a profile.</p>
          <iframe key={mode} src={`/demo?tn=${mode}`} title="Alook workspace, themed" className={s.realShell} />
          <p className={s.hint}>Then each part on its own, with every state.</p>
          <AppComponents />
        </Section>

        <Section title="Settings">
          <AppSettingsSpecimens mode={mode} />
        </Section>

        <Section title="Bots">
          <AppBotsSpecimens mode={mode} />
        </Section>

        <Section title="People">
          <AppPeopleSpecimens mode={mode} />
        </Section>

        <Section title="Onboarding">
          <AppOnboardingSpecimens mode={mode} />
        </Section>
      </div>
    </main>
  )
}

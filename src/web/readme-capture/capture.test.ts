import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

function webRoot() {
  return process.cwd().endsWith(`${path.sep}src${path.sep}web`)
    ? process.cwd()
    : path.join(process.cwd(), "src/web")
}

describe("standalone README capture app contract", () => {
  const root = webRoot()
  const repositoryRoot = path.resolve(root, "../..")
  const captureRoot = path.join(root, "readme-capture")
  const captureSource = readFileSync(path.join(captureRoot, "app/page.tsx"), "utf8")
  const generatorSource = readFileSync(path.join(captureRoot, "capture.mjs"), "utf8")
  const generatorReadmeSource = readFileSync(path.join(captureRoot, "README.md"), "utf8")
  const repositoryReadmeSource = readFileSync(path.join(repositoryRoot, "README.md"), "utf8")
  const overviewSource = readFileSync(
    path.join(captureRoot, "captures/overview-capture.tsx"),
    "utf8",
  )
  const identitySource = readFileSync(
    path.join(captureRoot, "captures/one-identity-capture.tsx"),
    "utf8",
  )
  const memorySource = readFileSync(
    path.join(captureRoot, "captures/memory-capture.tsx"),
    "utf8",
  )
  const localSource = readFileSync(
    path.join(captureRoot, "captures/local-first-capture.tsx"),
    "utf8",
  )
  const reachSource = readFileSync(
    path.join(captureRoot, "captures/reach-capture.tsx"),
    "utf8",
  )
  const collaborationSource = readFileSync(
    path.join(captureRoot, "captures/collaboration-capture.tsx"),
    "utf8",
  )
  const motionSource = readFileSync(
    path.join(root, "src/components/home/landing-shell-motion.tsx"),
    "utf8",
  )
  const inviteSource = readFileSync(
    path.join(root, "src/app/c/invite/[token]/invite-accept-client.tsx"),
    "utf8",
  )

  it("stays outside the production App Router", () => {
    expect(existsSync(path.join(root, "src/app/readme-capture/page.tsx"))).toBe(false)
    expect(existsSync(path.join(captureRoot, "app/page.tsx"))).toBe(true)
  })

  it("writes every output into the grouped README asset directory", () => {
    const filenames = [
      "banner.png",
      "overview.png",
      "one-identity.png",
      "memory.png",
      "reach.png",
      "local-first.png",
      "collaboration.png",
    ]

    expect(generatorSource).toContain('const readmeAssetsRoot = path.join(assetsRoot, "readme")')
    for (const filename of filenames) {
      expect(generatorSource).toContain(`"${filename}"`)
      expect(generatorReadmeSource).toContain(`assets/readme/${filename}`)
      expect(repositoryReadmeSource).toContain(`./assets/readme/${filename}`)
      expect(existsSync(path.join(repositoryRoot, "assets/readme", filename))).toBe(true)
    }
  })

  it("composes the real application surfaces for every retained capture", () => {
    expect(captureSource).toContain('from "../captures/overview-capture"')
    expect(captureSource).toContain('from "../captures/one-identity-capture"')
    expect(captureSource).toContain('from "../captures/memory-capture"')
    expect(captureSource).toContain('from "../captures/reach-capture"')
    expect(captureSource).toContain('from "../captures/local-first-capture"')
    expect(captureSource).toContain('from "../captures/collaboration-capture"')
    expect(captureSource).toContain("<OverviewCapture />")
    expect(captureSource).toContain("<OneIdentityCapture />")
    expect(captureSource).toContain("<MemoryCapture />")
    expect(captureSource).toContain("<ReachCapture />")
    expect(captureSource).toContain("<LocalFirstCapture />")
    expect(captureSource).toContain("<CollaborationCapture />")
    expect(overviewSource).toContain('id="capture-overview"')
    expect(overviewSource).toContain('<LandingShellMotion scene="server" beat={6} overviewDetails />')
    expect(identitySource).toContain('from "@/modules/community/client"')
    expect(identitySource).toContain("<ChannelPreview")
    expect(identitySource).not.toContain("@/components/community/channels/channel-header")
    expect(identitySource).not.toContain("@/components/community/messages/message\"")
    expect(identitySource).toContain('from "@/components/community/social/profile-card"')
    expect(identitySource).toContain('id="capture-identity"')
    expect(identitySource).toContain('grid-template-rows: repeat(2, minmax(0, 1fr))')
    expect(identitySource).toContain('width: 610.667px')
    expect(identitySource).toContain('height: 330px')
    expect(identitySource).toContain('transform: scale(1.8666667)')
    expect(identitySource).toContain('transform: scale(1.4)')
    expect(identitySource).toContain('width: 71.4286%')
    expect(identitySource).toContain('identity-message-pane')
    expect(identitySource).toContain('margin-top: 0 !important')
    expect(identitySource).not.toContain('font-size: 17px !important')
    expect(identitySource.indexOf('serverName: "Home"')).toBeLessThan(
      identitySource.indexOf('serverName: "Studio"'),
    )
    expect(identitySource).not.toContain("ChannelSidebar")
    expect(identitySource).not.toContain("ServerRail")
    expect(identitySource).not.toContain('serverId: "gus",\n    serverName: "Gus"')
    expect(memorySource).toContain('from "@/components/home/landing-shell-motion"')
    expect(memorySource).toContain('id="capture-memory"')
    expect(memorySource).toContain('<LandingShellMotion scene="continuity" beat={6} />')
    expect(memorySource).toContain('<LandingShellMotion scene="continuity" beat={9} />')
    expect(memorySource.indexOf('beat={6}')).toBeLessThan(memorySource.indexOf('beat={9}'))
    expect(memorySource).toContain('[class*="inboxSurface"]')
    expect(memorySource).toContain('[data-motion-target^="continuity-dm-"]')
    expect(memorySource).toContain('transform: scale(1.4) !important')
    expect(memorySource).toContain('width: 71.4286%')
    expect(memorySource).toContain(':has([data-motion-target="continuity-dm-gus"])')
    expect(memorySource).toContain(':has([data-motion-target="continuity-work-alli"])')
    expect(memorySource).toContain('padding-top: 0 !important')
    expect(memorySource).toContain('margin-top: 0 !important')
    expect(memorySource).not.toContain('transform: none !important')
    expect(motionSource).toContain('scene === "continuity"')
    expect(motionSource).toContain('const OVERVIEW_SERVERS: Server[]')
    expect(motionSource).toContain('rootChannels={overviewDetails && scene === "server" ? SPACE_CHANNELS.work : CHANNELS}')
    expect(motionSource).toContain('typingNames={showTypingPill ? [DMS[0].name] : []}')
    expect(motionSource).toContain('SPACE_SERVERS.map((server) => ({ ...server, active: server.id === room }))')
    expect(memorySource).not.toContain("highlightAuthorId")
    expect(localSource).toContain('id="capture-local"')
    expect(localSource).toContain('width: 870px !important')
    expect(localSource).toContain('height: 489.375px !important')
    expect(localSource).toContain('transform: scale(1.4712644) !important')
    expect(localSource).not.toContain('translate(')
    expect(motionSource).toContain('scene === "server" || scene === "machine"')
    expect(reachSource).toContain('id="capture-reach"')
    expect(reachSource).toContain('<LandingShellMotion scene="server" beat={6} />')
    expect(reachSource).toContain('<LandingMobileChatMotion beat={6} />')
    expect(reachSource).toContain('width: 884px')
    expect(reachSource).toContain('height: 672px')
    expect(reachSource).toContain('transform: scale(1.22) !important')
    expect(reachSource).toContain('width: 343px !important')
    expect(reachSource).toContain('height: 693px !important')
    expect(reachSource).toContain('transform: scale(0.9504) !important')
    expect(collaborationSource).toContain('id="capture-collaboration"')
    expect(collaborationSource).toContain('className="collaboration-content')
    expect(collaborationSource).toContain('transform: scale(1.9941)')
    expect(motionSource).not.toContain("highlightAuthorId")
    expect(overviewSource).toContain("transform: scale(1.4485)")
  })

  it("reuses canonical message and invite copy", () => {
    const canonicalOverviewMessages = [
      "hello world",
      "On it.",
      "I’ll review the flow.",
      "Ready to ship.",
    ]
    const canonicalMessages = [
      "@Shelly#3863 How are Gus’s A/B landing pages converting today?",
      "B is ahead on sign-ups. I’m checking the mobile drop-off.",
      "@Tracy#2048 Is the router at home still dropping out?",
      "Yes — it dropped twice this morning.",
    ]
    const canonicalInviteCopy = [
      "You&apos;re invited to join",
      "Invited by",
      "Join server",
      "Free to join · leave anytime",
    ]

    for (const copy of canonicalOverviewMessages) {
      expect(motionSource).toContain(copy)
    }
    for (const copy of canonicalMessages) {
      expect(motionSource).toContain(copy)
      expect(identitySource).toContain(copy)
    }
    for (const copy of canonicalInviteCopy) {
      expect(inviteSource).toContain(copy)
      expect(collaborationSource).toContain(copy)
    }
  })
})

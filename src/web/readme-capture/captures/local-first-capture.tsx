"use client"

import { useState } from "react"
import type { CommunityMachineSummary } from "@alook/shared"
import { BotCardView } from "@/components/community/bots/bot-card-view"
import { MachineCard } from "@/components/community/machines/machine-card"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import { LandingShellMotion } from "@/components/home/landing-shell-motion"
import { Button } from "@/components/ui/button"
import type { DM } from "@/lib/community/models/people"

const ignore = () => {}

const LOCAL_DMS: DM[] = [
  { id: "loc-dm-alli", userId: "loc-alli", name: "Alli", discriminator: "6011", avatar: "avatar:beam:Alli", avatarVersion: 0, status: "online", preview: "Claude Code · Online" },
  { id: "loc-dm-claudette", userId: "loc-claudette", name: "Claudette", discriminator: "5211", avatar: "avatar:beam:Claudette", avatarVersion: 0, status: "online", preview: "Codex · Online" },
  { id: "loc-dm-austina", userId: "loc-austina", name: "Austina", discriminator: "3717", avatar: "avatar:beam:Austina", avatarVersion: 0, status: "online", preview: "Antigravity · Online" },
]

function buildLocalMachine(nowIso: string): CommunityMachineSummary {
  return {
    id: "loc-macbook",
    hostname: "gus-macbook-pro.local",
    displayName: "Gus’s MacBook Pro",
    platform: "darwin",
    arch: "arm64",
    osRelease: "15.6",
    daemonVersion: "0.1.71",
    status: "online",
    lastSeenAt: nowIso,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: nowIso,
    availableRuntimes: [
      { id: "claude", status: "healthy" },
      { id: "codex-cli", status: "healthy" },
      { id: "cursor", status: "healthy" },
      { id: "antigravity", status: "healthy" },
      { id: "grok", status: "healthy" },
      { id: "opencode", status: "healthy" },
      { id: "pi", status: "healthy" },
      { id: "copilot", status: "healthy" },
      { id: "qoder", status: "healthy" },
    ],
  } as CommunityMachineSummary
}

const LOCAL_BOTS = [
  { id: "loc-alli", name: "Alli", image: "avatar:beam:Alli", runtime: "claude", modelName: "claude-opus-5-5", lastRefreshContextAt: null },
  { id: "loc-claudette", name: "Claudette", image: "avatar:beam:Claudette", runtime: "codex-cli", modelName: "gpt-5.4", lastRefreshContextAt: null },
  { id: "loc-austina", name: "Austina", image: "avatar:beam:Austina", runtime: "antigravity", modelName: null, lastRefreshContextAt: null },
  { id: "loc-evan", name: "Evan", image: "avatar:beam:Evan", runtime: "cursor", modelName: null, lastRefreshContextAt: null },
] as const

export function LocalFirstCapture() {
  const [machine] = useState(() => buildLocalMachine(new Date().toISOString()))

  return (
    <>
      <section id="capture-local" className="feature-canvas local-canvas capture-static">
        <div className="tn-window local-window">
          <CommunityPreviewNavigation value={true}>
            <LandingShellMotion
              scene="machine"
              beat={0}
              dms={LOCAL_DMS}
              userAvatar={LANDING_HUMAN_AVATARS.gus}
            >
              <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden p-6">
                <div className="flex flex-col gap-3">
                  <header className="flex items-center justify-between gap-4">
                    <div>
                      <div className="font-heading text-xl font-semibold leading-[1.15] tracking-[-0.015em] text-foreground">
                        Machines
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Your computers running the alook daemon.
                      </p>
                    </div>
                    <Button size="sm" className="h-9 rounded-lg px-4 text-xs font-semibold">
                      Connect a machine
                    </Button>
                  </header>
                  <MachineCard machine={machine} onDelete={ignore} onReconnect={ignore} />
                </div>

                <div className="flex flex-col gap-2.5">
                  <div className="font-heading text-base font-semibold leading-[1.15] tracking-[-0.015em] text-foreground">
                    My Bots
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {LOCAL_BOTS.map((bot) => (
                      <BotCardView
                        key={bot.id}
                        bot={bot}
                        online={true}
                        statusKnown={true}
                        statusLabel="Online"
                      />
                    ))}
                  </div>
                </div>
              </div>
            </LandingShellMotion>
          </CommunityPreviewNavigation>
        </div>

        <div className="local-terminal" aria-label="Local daemon status">
          <div className="local-terminal-head">
            <span className="local-terminal-dots">
              <span />
              <span />
              <span />
            </span>
            <span className="local-terminal-title">gus-macbook-pro · local daemon</span>
          </div>
          <div className="local-terminal-body">
            <div><span className="t-prompt">$</span> npx @alook/app onboard</div>
            <div className="t-ok">✓ Paired Gus’s MacBook Pro (darwin · arm64)</div>
            <div className="t-ok">✓ 9 local runtimes ready · agents stay on your machine</div>
          </div>
        </div>
      </section>

      <style jsx global>{`
        .local-window {
          position: absolute;
          top: 28px;
          left: 34px;
          width: 1180px;
          height: 616px;
        }

        .local-window [data-testid="landing-motion-stage"] {
          width: 1180px;
          height: 616px;
          aspect-ratio: auto;
        }

        .local-window [data-testid="landing-motion-stage"] > div {
          width: 1030px !important;
          height: 538px !important;
          transform: scale(1.1456) !important;
          transform-origin: top left !important;
        }

        .local-window [data-testid="landing-motion-stage"] > div > div {
          width: 1030px !important;
          height: 538px !important;
        }

        .local-terminal {
          position: absolute;
          z-index: 4;
          right: 28px;
          bottom: 24px;
          width: 496px;
          overflow: hidden;
          border: 1px solid rgb(255 255 255 / 14%);
          border-radius: 14px;
          background: #141414;
          color: #ededed;
          font-family: var(--font-dm-mono), ui-monospace, monospace;
          box-shadow:
            0 22px 46px rgb(31 26 21 / 32%),
            0 6px 14px rgb(31 26 21 / 18%),
            0 0 0 4px rgb(250 246 238 / 92%);
          transform: rotate(-1.3deg);
        }

        .local-terminal-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgb(255 255 255 / 8%);
          background: #1c1c1c;
          padding: 8px 14px;
        }

        .local-terminal-dots {
          display: flex;
          gap: 6px;
        }

        .local-terminal-dots span {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #3a3a3a;
        }

        .local-terminal-dots span:first-child {
          background: #e06c5c;
        }

        .local-terminal-dots span:nth-child(2) {
          background: #e3a84f;
        }

        .local-terminal-dots span:nth-child(3) {
          background: #6fe0a6;
        }

        .local-terminal-title {
          font-size: 11px;
          color: #9b958b;
        }

        .local-terminal-body {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 12px 16px 14px;
          font-size: 12.5px;
          line-height: 1.45;
        }

        .local-terminal-body .t-prompt {
          color: #7d98ff;
          margin-right: 6px;
        }

        .local-terminal-body .t-ok {
          color: #6fe0a6;
        }
      `}</style>
    </>
  )
}

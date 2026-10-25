"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import LandingInteractiveShell from "@/components/home/landing-interactive-shell"
import { CONTINUITY_WORK_MESSAGES, LANDING_PREVIEW_PROFILES, LandingShellMotion } from "@/components/home/landing-shell-motion"
import LandingProfileContent from "@/components/home/landing-profile-content"
import { DEMO_MESSAGES, DEMO_PROFILES } from "@/components/home/landing-interactive-shell-data"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import { Message } from "@/components/community/messages/message"
import { Composer } from "@/components/community/messages/composer"

function FixtureProviders({ children, identity = false }: { children: ReactNode; identity?: boolean }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } }))
  const [registry] = useState(() => createCommunityDbRegistry(queryClient, null))
  const lifetimeRef = useRef({ generation: 0 })
  useEffect(() => {
    const lifetime = lifetimeRef.current
    const generation = ++lifetime.generation
    return () => queueMicrotask(() => {
      if (lifetime.generation === generation) void registry.cleanup().finally(() => queryClient.clear())
    })
  }, [registry, queryClient])
  return <QueryClientProvider client={queryClient}><CommunityDbProvider registry={registry}><CommunityPreviewProfileOwner profiles={identity ? LANDING_PREVIEW_PROFILES : DEMO_PROFILES}>{children}</CommunityPreviewProfileOwner></CommunityDbProvider></QueryClientProvider>
}

export function CaptureSurface({ scene, beat }: { scene: string; beat: number }) {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const reply = DEMO_MESSAGES["demo-general"].find(message => message.authorId === "demo-alli")!
  const content = scene === "workspace" ? <LandingInteractiveShell />
    : scene === "profile" ? <FixtureProviders><LandingProfileContent /></FixtureProviders>
    : scene === "reply" ? <FixtureProviders><div className="p-4"><Message m={reply} onOpenThread={() => undefined} /></div></FixtureProviders>
    : scene === "continuity-ask" || scene === "continuity-answer" ? <FixtureProviders identity><div className="p-4"><Message m={CONTINUITY_WORK_MESSAGES[scene === "continuity-ask" ? 0 : 1]} onOpenThread={() => undefined} /></div></FixtureProviders>
    : scene === "composer" ? <FixtureProviders><div className="flex h-full flex-col justify-end"><Composer channel="general" context="channel" members={[]} sendContract="accepted" onAcceptSend={() => false} autoFocus={false} /></div></FixtureProviders>
    : scene === "identity" || scene === "continuity" || scene === "provider" ? <LandingShellMotion scene={scene} beat={beat} />
    : null
  return <main data-capture-surface={scene} data-capture-ready={ready ? "true" : undefined} className={`capture-surface surface-${scene}`}>
    {ready ? content : null}
    <style jsx global>{`
      .capture-surface { width: 100vw; height: 100dvh; overflow: hidden; background: var(--background); color: var(--foreground); font-family: var(--font-dm-sans), sans-serif; }
      .surface-profile { display: flex; align-items: center; justify-content: center; }
      .surface-profile > div { width: 300px; }
      .capture-surface [data-testid="landing-motion-stage"] { width: 1120px; height: 660px; }
      .capture-surface [data-testid="landing-motion-stage"] > div > div { transform: scale(1) !important; transition: none !important; }
      .capture-surface [data-testid="landing-motion-cursor"] { display: none !important; }
    `}</style>
  </main>
}

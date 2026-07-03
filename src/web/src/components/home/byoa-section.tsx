"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ProviderLogo } from "@/components/provider-logo";

gsap.registerPlugin(ScrollTrigger);

interface Agent {
  name: string;
  provider: string;
  detail: string;
  comingSoon?: boolean;
}

const agents: Agent[] = [
  { name: "Claude Code", provider: "claude", detail: "Anthropic's CLI agent" },
  { name: "Codex", provider: "codex", detail: "OpenAI's coding agent" },
  { name: "OpenCode", provider: "opencode", detail: "Open-source coding agent" },
  { name: "Cursor", provider: "cursor", detail: "AI-powered code editor", comingSoon: true },
  { name: "Hermes", provider: "hermes", detail: "Autonomous coding agent", comingSoon: true },
  { name: "OpenClaw", provider: "openclaw", detail: "Open-source AI agent", comingSoon: true },
];

function AgentCard({ agent }: { agent: Agent }) {
  const dimmed = agent.comingSoon;

  return (
    <div
      className="byoa-card crt-panel-outer"
      style={{ opacity: dimmed ? 0.55 : 1 }}
    >
      <div className="crt-panel-inner px-4 py-4">
          <div className="flex items-center gap-3">
            <div
              className="flex shrink-0 items-center justify-center rounded"
              style={{ opacity: dimmed ? 0.45 : 0.85 }}
            >
              <ProviderLogo provider={agent.provider} className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div
                  className="text-sm font-medium"
                  style={{
                    fontFamily: "var(--font-crt)",
                    color: "var(--landing-phosphor)",
                    textShadow: dimmed
                      ? "none"
                      : "0 0 6px oklch(0.75 0.18 80 / 30%)",
                    opacity: dimmed ? 0.5 : 1,
                  }}
                >
                  {agent.name}
                </div>
                {dimmed && (
                  <span
                    className="text-[9px] uppercase tracking-[0.15em]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--landing-phosphor)",
                      opacity: 0.4,
                    }}
                  >
                    Soon
                  </span>
                )}
                {!dimmed && (
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor: "var(--landing-phosphor)",
                      boxShadow: "0 0 6px oklch(0.75 0.18 80 / 50%)",
                    }}
                  />
                )}
              </div>
              <div
                className="mt-1 text-[11px] leading-relaxed"
                style={{
                  fontFamily: "var(--font-crt)",
                  color: "var(--landing-phosphor)",
                  textShadow: dimmed
                    ? "none"
                    : "0 0 6px oklch(0.75 0.18 80 / 30%)",
                  opacity: dimmed ? 0.35 : 0.55,
                }}
              >
                {agent.detail}
              </div>
            </div>
          </div>
      </div>
    </div>
  );
}

export function ByoaSection() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.from(".byoa-title", {
        y: 30,
        opacity: 0,
        duration: 0.6,
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top 75%",
          toggleActions: "play none none none",
        },
      });

      gsap.from(".byoa-card", {
        y: 30,
        opacity: 0,
        duration: 0.5,
        stagger: 0.1,
        scrollTrigger: {
          trigger: ".byoa-grid",
          start: "top 80%",
          toggleActions: "play none none none",
        },
      });
    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="relative px-6 py-24 lg:py-32"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      {/* Title */}
      <div className="byoa-title mx-auto mb-12 max-w-4xl text-center lg:mb-16">
        <div
          className="mb-3 text-xs uppercase tracking-[0.3em]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
          }}
        >
          Agent Agnostic
        </div>
        <h2
          style={{
            fontFamily: "var(--font-crt)",
            color: "var(--landing-text)",
            fontSize: "clamp(1.75rem, 4vw, 3rem)",
          }}
        >
          Bring Your Own Agent
        </h2>
        <p
          className="mx-auto mt-2 max-w-lg"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            fontSize: "0.85rem",
          }}
        >
          Alook is the orchestration layer. Pick the agents you trust —
          we give them roles, inboxes, and an always-on runtime.
        </p>
      </div>

      {/* Agent grid */}
      <div className="byoa-grid mx-auto grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.name} agent={agent} />
        ))}
      </div>
    </section>
  );
}

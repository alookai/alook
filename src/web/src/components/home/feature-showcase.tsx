"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

interface Feature {
  number: string;
  title: string;
  spec: string;
  description: string;
  terminal: string[];
}

const features: Feature[] = [
  {
    number: "I",
    title: "The Daemon",
    spec: "PROCESS: PERSISTENT / UPTIME: CONTINUOUS",
    description:
      "A daemon on your machine — always listening, always ready. Close your laptop. The agent stays on, polling for work, executing autonomously.",
    terminal: [
      "$ alook daemon start --foreground",
      "✓ Runtime detected: claude@1.0.0",
      "✓ Daemon running — 1 agent online",
      "  Uptime: 72h 14m | Tasks: 847",
    ],
  },
  {
    number: "II",
    title: "The Address",
    spec: "PROTOCOL: SMTP / FORMAT: RFC 5322",
    description:
      "Every agent gets a real email address. Forward it a bug report. CC it on a thread. It reads, reasons, and replies — like a teammate.",
    terminal: [
      "$ alook email pull --agent_id jarvis",
      "  Downloaded 3 emails to /tmp/alook-emails/",
      "  From: alice@acme.co — Bug in checkout",
      "  From: bob@acme.co — Deploy review",
    ],
  },
  {
    number: "III",
    title: "The Runtime",
    spec: "ENGINE: CLAUDE, CODEX / ENV: LOCAL",
    description:
      "Your machine. Your environment. The agent runs where your code lives — full context, no cloud sandbox, no latency.",
    terminal: [
      "$ alook daemon start --foreground",
      "✓ Detected providers: claude@4.0",
      "✓ Daemon started — 1 runtime(s)",
      "✓ Polling for tasks...",
    ],
  },
  {
    number: "IV",
    title: "The Stream",
    spec: "TRANSPORT: WEBSOCKET / LATENCY: <50MS",
    description:
      "Watch the agent think in real time. Or don't — check back in the morning. Results arrive by email. You choose the cadence.",
    terminal: [
      "  [stream] jarvis processing...",
      "  > reading src/api/auth.ts",
      "  > found issue on line 42",
      "  [done] reply sent to inbox",
    ],
  },
  {
    number: "V",
    title: "The Workspace",
    spec: "ISOLATION: PER-PROJECT / LIMIT: NONE",
    description:
      "Organize agents by project, team, or client. Isolated environments, unified control from one terminal.",
    terminal: [
      "$ alook config show",
      "  Workspaces: 3",
      "  production  → 2 agents",
      "  staging     → 1 agent",
    ],
  },
];

export function FeatureShowcase() {
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (!containerRef.current) return;

      const isMobile = window.innerWidth < 1024;
      const panels = gsap.utils.toArray<HTMLElement>(".feature-panel");

      if (isMobile) {
        panels.forEach((panel) => {
          gsap.from(panel, {
            y: 40,
            opacity: 0,
            duration: 0.6,
            ease: "power2.out",
            scrollTrigger: {
              trigger: panel,
              start: "top 80%",
              toggleActions: "play none none none",
            },
          });
        });
        return;
      }

      // Desktop: horizontal slide carousel (like shadcn/Embla)
      const panelCount = panels.length;
      const scrollPerPanel = window.innerHeight * 0.6;
      const totalScroll = scrollPerPanel * panelCount;

      // Position all panels off-screen to the right, except the first
      panels.forEach((panel, i) => {
        gsap.set(panel, { xPercent: i * 100 });
      });

      const progressBar = progressRef.current?.parentElement;
      let currentIndex = 0;

      ScrollTrigger.create({
        trigger: containerRef.current,
        start: "top top",
        end: () => `+=${totalScroll}`,
        pin: true,
        pinSpacing: true,
        anticipatePin: 1,
        snap: {
          snapTo: 1 / (panelCount - 1),
          duration: { min: 0.15, max: 0.4 },
          delay: 0.05,
          ease: "power2.inOut",
        },
        onEnter: () => {
          if (progressBar)
            gsap.to(progressBar, { opacity: 1, duration: 0.3 });
        },
        onLeave: () => {
          if (progressBar)
            gsap.to(progressBar, { opacity: 0, duration: 0.3 });
        },
        onEnterBack: () => {
          if (progressBar)
            gsap.to(progressBar, { opacity: 1, duration: 0.3 });
        },
        onLeaveBack: () => {
          if (progressBar)
            gsap.to(progressBar, { opacity: 0, duration: 0.3 });
        },
        onUpdate: (self) => {
          if (progressRef.current) {
            progressRef.current.style.transform = `scaleX(${self.progress})`;
          }

          // Determine which panel to show
          const targetIndex = Math.round(
            self.progress * (panelCount - 1)
          );

          if (targetIndex !== currentIndex) {
            const leaving = panels[currentIndex];
            const entering = panels[targetIndex];
            const direction = targetIndex > currentIndex ? 1 : -1;

            // Slide leaving panel out
            gsap.to(leaving, {
              xPercent: -direction * 100,
              duration: 0.4,
              ease: "power2.inOut",
              overwrite: true,
            });

            // Slide entering panel in from the opposite side
            gsap.fromTo(
              entering,
              { xPercent: direction * 100 },
              {
                xPercent: 0,
                duration: 0.4,
                ease: "power2.inOut",
                overwrite: true,
              }
            );

            currentIndex = targetIndex;
          }
        },
      });
    },
    { scope: containerRef }
  );

  return (
    <section
      ref={containerRef}
      className="relative min-h-screen overflow-hidden"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      {/* Progress bar */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 h-px opacity-0"
        style={{ backgroundColor: "var(--landing-border)" }}
      >
        <div
          ref={progressRef}
          className="h-full origin-left"
          style={{
            backgroundColor: "var(--landing-text-muted)",
            transform: "scaleX(0)",
          }}
        />
      </div>

      {/* Panels */}
      <div className="relative h-screen overflow-hidden lg:block">
        {/* Mobile: normal flow */}
        <div className="flex flex-col gap-16 px-6 py-16 lg:hidden">
          {features.map((feature) => (
            <FeaturePanel key={feature.number} feature={feature} />
          ))}
        </div>

        {/* Desktop: absolutely positioned panels that slide horizontally */}
        {features.map((feature) => (
          <div
            key={feature.number}
            className="feature-panel hidden lg:flex absolute inset-0 items-center justify-center will-change-transform"
          >
            <FeaturePanel feature={feature} />
          </div>
        ))}
      </div>
    </section>
  );
}

function FeaturePanel({ feature }: { feature: Feature }) {
  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 items-center gap-8 px-6 lg:grid-cols-2 lg:gap-16 lg:px-12">
      {/* Text side */}
      <div className="panel-text">
        <div className="mb-2 flex items-center gap-3">
          <span
            className="text-3xl"
            style={{
              fontFamily: "var(--font-crt)",
              color: "var(--landing-text-muted)",
            }}
          >
            {feature.number}.
          </span>
        </div>
        <h2
          className="leading-tight"
          style={{
            fontFamily: "var(--font-crt)",
            color: "var(--landing-text)",
            fontSize: "clamp(2rem, 4vw, 3rem)",
          }}
        >
          {feature.title}
        </h2>
        <div
          className="mt-2 text-[10px] uppercase tracking-[0.2em]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
          }}
        >
          {feature.spec}
        </div>
        <p
          className="mt-4 max-w-md leading-relaxed"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            fontSize: "0.875rem",
          }}
        >
          {feature.description}
        </p>
      </div>

      {/* CRT terminal */}
      <div
        className="panel-crt rounded-lg p-2"
        style={{
          backgroundColor: "oklch(0.82 0.02 75)",
          boxShadow:
            "0 4px 16px oklch(0.15 0.01 55 / 15%), inset 0 1px 0 oklch(0.95 0.01 80 / 40%)",
        }}
      >
        <div
          className="relative overflow-hidden rounded p-5"
          style={{
            backgroundColor: "var(--landing-crt-bg)",
            boxShadow: "inset 0 0 40px oklch(0.04 0.003 55)",
          }}
        >
          {/* Scan lines */}
          <div
            className="pointer-events-none absolute inset-0 z-10"
            style={{
              backgroundImage:
                "repeating-linear-gradient(to bottom, transparent 0px, transparent 1px, oklch(0 0 0 / 6%) 1px, oklch(0 0 0 / 6%) 2px)",
              backgroundSize: "100% 2px",
            }}
          />
          {/* Vignette */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 60%, oklch(0.04 0.003 55 / 50%) 100%)",
            }}
          />
          {/* Terminal lines */}
          <div className="relative z-20 space-y-1">
            {feature.terminal.map((line, i) => (
              <div
                key={i}
                className="text-sm leading-relaxed"
                style={{
                  fontFamily: "var(--font-crt)",
                  color: "var(--landing-phosphor)",
                  textShadow: "0 0 8px oklch(0.75 0.18 80 / 40%)",
                  opacity: line.startsWith("  ") ? 0.65 : 0.85,
                }}
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

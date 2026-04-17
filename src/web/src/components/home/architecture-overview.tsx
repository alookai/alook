"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

interface ZoneItem {
  label: string;
  detail: string;
}

const localZone: ZoneItem[] = [
  { label: "AI Agent", detail: "Runs tasks on your machine" },
  { label: "Your Codebase", detail: "Full access, nothing leaves" },
  { label: "Local Tools", detail: "Git, shell, editors — all yours" },
];

const cloudZone: ZoneItem[] = [
  { label: "Email Inbox", detail: "Receives emails for your agent" },
  { label: "Dashboard", detail: "Monitor and review in real-time" },
  { label: "Sync Layer", detail: "Keeps everything connected" },
];

function ZoneCard({
  title,
  subtitle,
  items,
  className,
}: {
  title: string;
  subtitle: string;
  items: ZoneItem[];
  className?: string;
}) {
  return (
    <div
      className={`arch-zone rounded-2xl p-6 ${className ?? ""}`}
      style={{
        backgroundColor: "var(--landing-surface)",
        border: "1px solid var(--landing-border)",
      }}
    >
      <div className="mb-5">
        <h3
          className="text-lg"
          style={{
            fontFamily: "var(--font-crt)",
            color: "var(--landing-text)",
          }}
        >
          {title}
        </h3>
        <div
          className="mt-1 text-xs"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
          }}
        >
          {subtitle}
        </div>
      </div>

      <div className="space-y-2.5">
        {items.map((item) => (
          <div
            key={item.label}
            className="rounded-lg p-1.5"
            style={{
              backgroundColor: "oklch(0.82 0.02 75)",
              boxShadow:
                "0 2px 8px oklch(0.15 0.01 55 / 10%), inset 0 1px 0 oklch(0.95 0.01 80 / 40%)",
            }}
          >
            <div
              className="relative overflow-hidden rounded px-4 py-3"
              style={{
                backgroundColor: "var(--landing-crt-bg)",
                boxShadow: "inset 0 0 20px oklch(0.04 0.003 55)",
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
              <div className="relative z-20">
                <div
                  className="text-xs font-medium"
                  style={{
                    fontFamily: "var(--font-crt)",
                    color: "var(--landing-phosphor)",
                    textShadow: "0 0 6px oklch(0.75 0.18 80 / 30%)",
                  }}
                >
                  {item.label}
                </div>
                <div
                  className="mt-0.5 text-[11px] leading-relaxed"
                  style={{
                    fontFamily: "var(--font-crt)",
                    color: "var(--landing-phosphor)",
                    textShadow: "0 0 6px oklch(0.75 0.18 80 / 30%)",
                    opacity: 0.55,
                  }}
                >
                  {item.detail}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionArrows() {
  return (
    <div className="arch-arrows flex flex-col items-center justify-center py-4 lg:py-0">
      {/* Desktop: horizontal bidirectional arrow */}
      <div className="hidden lg:flex flex-col items-center gap-3">
        <span
          className="text-[10px]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            opacity: 0.6,
          }}
        >
          tasks & results
        </span>
        <svg
          width="120"
          height="20"
          viewBox="0 0 120 20"
          style={{ overflow: "visible" }}
        >
          <polygon
            points="4,6 0,10 4,14"
            fill="var(--landing-text-muted)"
            opacity="0.4"
          />
          <line
            x1="6"
            y1="10"
            x2="114"
            y2="10"
            stroke="var(--landing-text-muted)"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity="0.35"
          />
          <polygon
            points="116,6 120,10 116,14"
            fill="var(--landing-text-muted)"
            opacity="0.4"
          />
        </svg>
        <span
          className="text-[10px]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            opacity: 0.6,
          }}
        >
          email in · updates out
        </span>
      </div>

      {/* Mobile: vertical bidirectional arrow */}
      <div className="flex lg:hidden flex-row items-center gap-3">
        <span
          className="text-[10px] text-right"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            opacity: 0.6,
          }}
        >
          tasks &<br />results
        </span>
        <svg
          width="20"
          height="60"
          viewBox="0 0 20 60"
          style={{ overflow: "visible" }}
        >
          <polygon
            points="6,4 10,0 14,4"
            fill="var(--landing-text-muted)"
            opacity="0.4"
          />
          <line
            x1="10"
            y1="6"
            x2="10"
            y2="54"
            stroke="var(--landing-text-muted)"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity="0.35"
          />
          <polygon
            points="6,56 10,60 14,56"
            fill="var(--landing-text-muted)"
            opacity="0.4"
          />
        </svg>
        <span
          className="text-[10px]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            opacity: 0.6,
          }}
        >
          email in ·<br />updates out
        </span>
      </div>
    </div>
  );
}

export function ArchitectureOverview() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.from(".arch-title", {
        y: 30,
        opacity: 0,
        duration: 0.6,
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top 75%",
          toggleActions: "play none none none",
        },
      });

      gsap.from(".arch-zone", {
        y: 40,
        opacity: 0,
        duration: 0.7,
        stagger: 0.2,
        scrollTrigger: {
          trigger: ".arch-diagram",
          start: "top 70%",
          toggleActions: "play none none none",
        },
      });

      gsap.from(".arch-arrows", {
        opacity: 0,
        duration: 0.5,
        delay: 0.3,
        scrollTrigger: {
          trigger: ".arch-diagram",
          start: "top 65%",
          toggleActions: "play none none none",
        },
      });
    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="relative flex min-h-screen flex-col items-center justify-center px-6 py-32"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      {/* Section title */}
      <div className="arch-title mb-16 text-center">
        <div
          className="mb-3 text-xs uppercase tracking-[0.3em]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
          }}
        >
          How It Works
        </div>
        <h2
          style={{
            fontFamily: "var(--font-crt)",
            color: "var(--landing-text)",
            fontSize: "clamp(1.75rem, 4vw, 3rem)",
          }}
        >
          Local Agent, Global Reach
        </h2>
        <p
          className="mt-2 max-w-lg mx-auto"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            fontSize: "0.85rem",
          }}
        >
          Your agent runs on your machine with full access to your tools.
          Alook connects it to email, dashboards, and the outside world.
        </p>
      </div>

      {/* Two-zone diagram */}
      <div className="arch-diagram mx-auto flex w-full max-w-4xl flex-col items-center gap-6 lg:flex-row lg:items-stretch lg:gap-8">
        <div className="w-full lg:flex-1">
          <ZoneCard
            title="Your Machine"
            subtitle="Private · Local files · full control"
            items={localZone}
          />
        </div>

        <ConnectionArrows />

        <div className="w-full lg:flex-1">
          <ZoneCard
            title="Alook Cloud"
            subtitle="Always on · globally reachable"
            items={cloudZone}
          />
        </div>
      </div>
    </section>
  );
}

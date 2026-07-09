"use client";

import { useEffect, useRef, useState } from "react";
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
  cta: { tagline: string; label: string; href: string };
}

const features: Feature[] = [
  {
    number: "I",
    title: "Collaboration",
    spec: "DEFINE YOUR COMPANY STRUCTURE",
    description:
      "You're the CEO. Assign agents to roles — dev, ops, research — and let them coordinate. Define your org chart, and Alook keeps everyone in sync.",
    terminal: [
      "▓▓▓▓▓▓▓▓▓           ▓▓▓▓▓▓▓▓▓           ▓▓▓▓▓▓▓▓▓",
      "▓  YOU  ▓░░░░░░░░░░░▓  DEV  ▓░░░░░░░░░░░▓  OPS  ▓",
      "▓▓▓▓▓▓▓▓▓           ▓▓▓▓▓▓▓▓▓           ▓▓▓▓▓▓▓▓▓",
      "    ░                   ░                   ░    ",
      "    ░                   ░                   ░    ",
      "▓▓▓▓▓▓▓▓▓           ▓▓▓▓▓▓▓▓▓           ▓▓▓▓▓▓▓▓▓",
      "▓  R&D  ▓░░░░░░░░░░░▓ SALES ▓░░░░░░░░░░░▓  BIZ  ▓",
      "▓▓▓▓▓▓▓▓▓           ▓▓▓▓▓▓▓▓▓           ▓▓▓▓▓▓▓▓▓",
    ],
    cta: { tagline: "Design your org chart", label: "BUILD YOUR TEAM", href: "/sign-in" },
  },
  {
    number: "II",
    title: "Traceable",
    spec: "EVERY INTERACTION · RECORDED · AUDITABLE",
    description:
      "Agents communicate through email and work on your local machine. Every instruction, decision, and reply is recorded — in your inbox or in local files. Full accountability, no black boxes.",
    terminal: [
      "█████████████████████████",
      "█▓▒                   ▒▓█",
      "█ ▓▒░               ░▒▓ █",
      "█   ▓▒░           ░▒▓   █",
      "█     ▓▒░       ░▒▓     █",
      "█       ▓▒░   ░▒▓       █",
      "█         ▓▒█▒▓         █",
      "█          ▒█▒          █",
      "█                       █",
      "█████████████████████████",
    ],
    cta: { tagline: "Full audit trail, zero black boxes", label: "SEE EVERY DECISION", href: "/sign-in" },
  },
  {
    number: "III",
    title: "Calendar",
    spec: "SHOWS UP AT THE RIGHT TIME",
    description:
      "Your agent manages its own schedule. It knows when to work, when to follow up, and when to wait — always on time, never in the way.",
    terminal: [
      "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓",
      "▓  M  T  W  T  F  S  S  ▓",
      "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓",
      "▓  ░  ░  ░  ░  ░  ░  ░  ▓",
      "▓  ░  ░  ░  ░  ░  ░  ░  ▓",
      "▓  ░  ░  ▒  ▓  ░  ░  ░  ▓",
      "▓  ░  ░  ░  ░  █  ░  ░  ▓",
      "▓  ░  ░  ░  ░  ░  ░  ░  ▓",
      "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓",
    ],
    cta: { tagline: "Agents that show up on time", label: "SET UP SCHEDULES", href: "/sign-in" },
  },
  {
    number: "IV",
    title: "Always-On",
    spec: "YOUR COMPANY NEVER SLEEPS",
    description:
      "A persistent daemon keeps every agent running around the clock — picking up tasks, responding to emails, shipping work while you sleep.",
    terminal: [
      "                         ",
      "                         ",
      "           █             ",
      "          █ █            ",
      "        ▒▓   █           ",
      "░░░░░░░░░     ▓   ▒░░░░░░",
      "               █ ▓       ",
      "                ▓        ",
      "                         ",
      "                         ",
    ],
    cta: { tagline: "Ship while you sleep", label: "START THE DAEMON", href: "/sign-in" },
  },
  {
    number: "V",
    title: "Self-Learning",
    spec: "EVERY TASK MAKES THE TEAM SMARTER",
    description:
      "Agents build memory from past work — decisions, preferences, context. Your company gets sharper with every conversation, every task, every day.",
    terminal: [
      "                         ",
      "            █            ",
      "           ▓█▓           ",
      "          ▒▓█▓▒          ",
      "         ░▒▓█▓▒░         ",
      "        ░░▒▓█▓▒░░        ",
      "       ░░░▒▓█▓▒░░░       ",
      "      ░░░░▒▓█▓▒░░░░      ",
      "     ░░░░░▒▓█▓▒░░░░░     ",
      "                         ",
    ],
    cta: { tagline: "Smarter with every task", label: "GROW YOUR TEAM", href: "/sign-in" },
  },
];

export function FeatureShowcase() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.from(".feature-hero", {
        y: 30,
        opacity: 0,
        duration: 0.6,
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top 75%",
          toggleActions: "play none none none",
        },
      });

      const panels = gsap.utils.toArray<HTMLElement>(".feature-row");
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
    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="relative overflow-hidden py-24 lg:py-32"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      {/* Section hero */}
      <div className="feature-hero mx-auto mb-20 max-w-4xl px-6 text-center lg:mb-28">
        <div
          className="mb-3 text-xs uppercase tracking-[0.3em]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
          }}
        >
          Features
        </div>
        <h2
          style={{
            fontFamily: "var(--font-crt)",
            color: "var(--landing-text)",
            fontSize: "clamp(1.75rem, 4vw, 3rem)",
          }}
        >
          Your Company, Your Agents
        </h2>
        <p
          className="mx-auto mt-3 max-w-xl"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
            fontSize: "0.85rem",
          }}
        >
          Define roles, assign agents, and let them run. Alook is the
          orchestration layer that turns agents into a company.
        </p>
      </div>

      <div className="mx-auto flex max-w-5xl flex-col gap-16 px-6 sm:gap-24 lg:gap-32 lg:px-12">
        {features.map((feature, i) => (
          <FeaturePanel key={feature.number} feature={feature} reversed={i % 2 === 1} />
        ))}
      </div>
    </section>
  );
}

function FeaturePanel({ feature, reversed }: { feature: Feature; reversed: boolean }) {
  return (
    <div className="feature-row grid w-full grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-16">
      {/* Text side */}
      <div className={`panel-text text-center lg:text-left ${reversed ? "lg:order-2" : ""}`}>
        <div className="mb-2 flex items-baseline justify-center gap-3 lg:justify-start">
          <span
            className="text-3xl"
            style={{
              fontFamily: "var(--font-crt)",
              color: "var(--landing-text-muted)",
            }}
          >
            {feature.number}.
          </span>
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
        </div>
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
          className="mx-auto mt-4 max-w-md leading-relaxed text-[0.8125rem] sm:text-[0.875rem] lg:mx-0"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
          }}
        >
          {feature.description}
        </p>
      </div>

      {/* Flip card */}
      <div className={`mx-auto w-full max-w-sm sm:max-w-md ${reversed ? "lg:order-1" : ""}`} style={{ isolation: "isolate" }}>
        <FlipCard feature={feature} />
      </div>
    </div>
  );
}

function FlipCard({ feature }: { feature: Feature }) {
  const [flipped, setFlipped] = useState(false);

  return (
    <div
      className="flip-card panel-crt relative z-1 cursor-pointer"
      style={{ perspective: "1200px" }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        setFlipped((f) => !f);
      }}
    >
      <div
        className="flip-card-inner relative w-full transition-transform duration-500 ease-out transform-3d"
        style={flipped ? { transform: "rotateY(180deg)" } : undefined}
      >
        {/* Front — ASCII art */}
        <div
          className="flip-card-front crt-panel-outer"
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
            pointerEvents: flipped ? "none" : undefined,
            boxShadow:
              "0 4px 16px oklch(0.15 0.01 55 / 15%), inset 0 1px 0 oklch(0.95 0.01 80 / 40%)",
          }}
        >
          <div className="crt-panel-inner p-4">
            <div className="flex items-center justify-center min-h-35">
              <AnimatedArt lines={feature.terminal} />
            </div>
          </div>
        </div>

        {/* Back — CTA */}
        <div
          className="flip-card-back absolute inset-0 flex flex-col items-center justify-center rounded-lg p-6"
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
            transform: "rotateY(180deg)",
            backgroundColor: "var(--landing-crt-bg)",
            boxShadow:
              "0 4px 16px oklch(0.15 0.01 55 / 15%)",
          }}
        >
          <p
            className="mb-4 text-center text-sm"
            style={{
              fontFamily: "var(--font-crt)",
              color: "var(--landing-phosphor)",
              textShadow: "0 0 6px oklch(0.75 0.18 80 / 30%)",
            }}
          >
            {feature.cta.tagline}
          </p>
          <a
            href={feature.cta.href}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-widest transition-opacity hover:opacity-80"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-crt-bg)",
              backgroundColor: "var(--landing-phosphor)",
              boxShadow: "0 0 12px oklch(0.75 0.18 80 / 40%)",
            }}
          >
            {feature.cta.label}
          </a>
        </div>
      </div>
    </div>
  );
}

const DENSITY = [" ", "░", "▒", "▓", "█"];

function AnimatedArt({ lines }: { lines: string[] }) {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!preRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const text = lines.join("\n");
    const chars = [...text];
    const meta = chars.map((c, i) => {
      const level = DENSITY.indexOf(c);
      let row = 0;
      let col = 0;
      for (let j = 0; j < i; j++) {
        if (text[j] === "\n") { row++; col = 0; } else { col++; }
      }
      return { orig: c, level, row, col };
    });

    let frame = 0;
    let animId: number | null = null;

    const animate = () => {
      frame++;
      if (frame % 2 === 0) {
        const buf: string[] = [];
        for (let i = 0; i < meta.length; i++) {
          const m = meta[i];
          if (m.level <= 0) { buf.push(m.orig); continue; }
          const wave = Math.sin(frame * 0.015 + m.row * 0.45 + m.col * 0.1);
          const shifted = Math.max(1, Math.min(4, m.level + Math.round(wave)));
          buf.push(DENSITY[shifted]);
        }
        if (preRef.current) preRef.current.textContent = buf.join("");
      }
      animId = requestAnimationFrame(animate);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (animId === null) animId = requestAnimationFrame(animate);
        } else {
          if (animId !== null) { cancelAnimationFrame(animId); animId = null; }
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(preRef.current);

    return () => {
      if (animId !== null) cancelAnimationFrame(animId);
      observer.disconnect();
    };
  }, [lines]);

  return (
    <pre
      ref={preRef}
      style={{
        fontFamily: "'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
        fontSize: "clamp(7px, 2.5vw, 13px)",
        color: "var(--landing-phosphor)",
        textShadow: "0 0 8px oklch(0.75 0.18 80 / 40%)",
        opacity: 0.8,
        lineHeight: 1.35,
        overflowX: "hidden",
      }}
    >
      {lines.join("\n")}
    </pre>
  );
}

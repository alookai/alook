"use client";

import { useEffect, useRef } from "react";
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

      <div className="mx-auto flex max-w-5xl flex-col gap-24 px-6 lg:gap-32 lg:px-12">
        {features.map((feature, i) => (
          <FeaturePanel key={feature.number} feature={feature} reversed={i % 2 === 1} />
        ))}
      </div>
    </section>
  );
}

function FeaturePanel({ feature, reversed }: { feature: Feature; reversed: boolean }) {
  return (
    <div className={`feature-row grid w-full grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-16 ${reversed ? "lg:[direction:rtl]" : ""}`}>
      {/* Text side */}
      <div className={`panel-text text-center lg:text-left ${reversed ? "lg:[direction:ltr]" : ""}`}>
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

      {/* CRT terminal */}
      <div
        className={`panel-crt rounded-lg p-2 ${reversed ? "lg:[direction:ltr]" : ""}`}
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
          {/* ASCII art */}
          <div className="relative z-20 flex items-center justify-center min-h-35">
            <AnimatedArt lines={feature.terminal} />
          </div>
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
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

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
    let animId: number;
    let visible = false;

    const observer = new IntersectionObserver(
      ([entry]) => { visible = entry.isIntersecting; },
      { threshold: 0.1 }
    );
    observer.observe(preRef.current);

    const animate = () => {
      if (visible) {
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
      }
      animId = requestAnimationFrame(animate);
    };

    animId = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(animId); observer.disconnect(); };
  }, [lines]);

  return (
    <pre
      ref={preRef}
      className="text-[10px] sm:text-[13px]"
      style={{
        fontFamily: "'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
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

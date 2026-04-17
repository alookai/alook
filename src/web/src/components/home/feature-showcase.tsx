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
    title: "Email",
    spec: "PROTOCOL: SMTP / FORMAT: RFC 5322",
    description:
      "Every colleague needs an inbox. Your agent gets a real email address — forward it a bug report, CC it on a thread. It reads, reasons, and replies.",
    terminal: [
      "█████████████████████████",
      "█                       █",
      "█                       █",
      "█                       █",
      "█     ░                 █",
      "█     ▒▓░               █",
      "█     ▓██▓░             █",
      "█     █████▓▒░          █",
      "█     ▓██████████▓▒░    █",
      "█████████████████████████",
    ],
  },
  {
    number: "II",
    title: "Calendar",
    spec: "SCHEDULING: AUTONOMOUS / SYNC: REAL-TIME",
    description:
      "Your colleague manages its own schedule. It knows when to work, when to follow up, and when to wait — time-aware, not just task-aware.",
    terminal: [
      "█████████████████████",
      "█░░░█░░░█░░░█░░░█░░░█",
      "█████████████████████",
      "█▒▒▒█░░░█░░░█░░░█░░░█",
      "█████████████████████",
      "█▓▓▓█▒▒▒█░░░█░░░█░░░█",
      "█████████████████████",
      "█████▓▓▓█▒▒▒█░░░█░░░█",
      "█████████████████████",
    ],
  },
  {
    number: "III",
    title: "Always-On",
    spec: "PROCESS: PERSISTENT / UPTIME: CONTINUOUS",
    description:
      "Your colleague never sleeps. A persistent daemon on your machine keeps agents always-on — polling for work, executing tasks, even while you're away.",
    terminal: [
      "░░░░░░░░░░░░░░░░░░░░░░░░",
      "░░░░░░░░░░░░░░░░░░░░░░░░",
      "░░░░░░░░░▒░░░░░░░░░░░░░░",
      "░░░░░░░░▒▓▒░░░░░░░░░░░░░",
      "░░░░░░░▒▓█▓▒░░░░░░░░░░░░",
      "▒▒▒▒▒▒▓█████▓▒░░░▒░░░░░░",
      "░░░░░░░▒▓█▓▒░░░▒▓█▓▒░░░░",
      "░░░░░░░░▒▓▒░░░░░▒▓▒░░░░░",
      "░░░░░░░░░▒░░░░░░░▒░░░░░░",
      "░░░░░░░░░░░░░░░░░░░░░░░░",
    ],
  },
  {
    number: "IV",
    title: "Long-Term Memory",
    spec: "STORAGE: LOCAL / PERSISTENCE: INDEFINITE",
    description:
      "Your colleague remembers everything. Context from past conversations, decisions, and preferences — all stored locally, building up over time.",
    terminal: [
      "                         ",
      "  ░  ▒░  ▓▒░  █▓▒░  ▓▒░ ",
      " ▒░  ▓▒░  █▓▒░  ▓▒░  █▓▒",
      "▓▒░  █▓▒░  ▓▒░  █▓▒░  ▓▒",
      "█▓▒░  ▓▒░  █▓▒░  ▓▒░  █▓",
      "▓▓▒░░▓▓▒░░▓▓▒░░▓▓▒░░▓▓▒░",
      "███▓▒███▓▒███▓▒███▓▒███▓▒",
      "█████████████████████████",
      "█████████████████████████",
      "█████████████████████████",
    ],
  },
];

export function FeatureShowcase() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
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
      className="relative overflow-hidden py-24"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
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
      <div className={`panel-text ${reversed ? "lg:[direction:ltr]" : ""}`}>
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
          <div className="relative z-20 flex items-center justify-center min-h-[140px]">
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
      className="text-[13px]"
      style={{
        fontFamily: "'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
        color: "var(--landing-phosphor)",
        textShadow: "0 0 8px oklch(0.75 0.18 80 / 40%)",
        opacity: 0.8,
        lineHeight: 1.35,
      }}
    >
      {lines.join("\n")}
    </pre>
  );
}

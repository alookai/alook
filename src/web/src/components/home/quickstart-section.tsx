"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const points = [
  "Your Machine, Your Rules",
  "No Vendor Lock-In",
  "One Command to Start",
];

export function QuickstartSection() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.from(".selfhost-title", {
        y: 30,
        opacity: 0,
        duration: 0.6,
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top 75%",
          toggleActions: "play none none none",
        },
      });

      gsap.from(".selfhost-point", {
        y: 25,
        opacity: 0,
        duration: 0.5,
        stagger: 0.12,
        scrollTrigger: {
          trigger: ".selfhost-grid",
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
      style={{ backgroundColor: "var(--landing-crt-bg)" }}
    >
      {/* Scan lines overlay */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to bottom, transparent 0px, transparent 1px, oklch(0 0 0 / 4%) 1px, oklch(0 0 0 / 4%) 2px)",
          backgroundSize: "100% 2px",
        }}
      />

      {/* Title */}
      <div className="selfhost-title relative mx-auto mb-12 max-w-4xl text-center lg:mb-16">
        <div
          className="mb-3 text-xs uppercase tracking-[0.3em]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-phosphor)",
            opacity: 0.6,
          }}
        >
          Open Source & Self-Hosted
        </div>
        <h2
          style={{
            fontFamily: "var(--font-crt)",
            color: "var(--landing-phosphor)",
            fontSize: "clamp(1.75rem, 4vw, 3rem)",
            textShadow: "0 0 12px oklch(0.75 0.18 80 / 30%)",
          }}
        >
          Own Your Infrastructure
        </h2>
        <p
          className="mx-auto mt-3 max-w-xl"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-phosphor)",
            fontSize: "0.85rem",
            opacity: 0.65,
          }}
        >
          Alook is fully open source. Self-host the entire platform, keep
          your data private, and run your AI company on hardware you control.
        </p>
      </div>

      {/* Points */}
      <div className="selfhost-grid relative mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {points.map((point) => (
          <span
            key={point}
            className="selfhost-point text-sm"
            style={{
              fontFamily: "var(--font-crt)",
              color: "var(--landing-phosphor)",
              textShadow: "0 0 6px oklch(0.75 0.18 80 / 25%)",
            }}
          >
            {point}
          </span>
        ))}
      </div>

      {/* CTA terminal */}
      <div className="relative mx-auto mt-10 max-w-md">
        <div
          className="rounded-lg border px-4 py-4"
          style={{
            borderColor: "oklch(0.75 0.18 80 / 20%)",
            backgroundColor: "oklch(0.12 0.01 55)",
          }}
        >
          <code
            className="block text-center text-sm leading-relaxed"
            style={{
              fontFamily: "var(--font-crt)",
              color: "var(--landing-phosphor)",
              textShadow: "0 0 6px oklch(0.75 0.18 80 / 30%)",
            }}
          >
            $ npx @alook/app onboard
          </code>
        </div>
      </div>

      {/* CTA */}
      <div className="relative mx-auto mt-8 flex justify-center">
        <a
          href="/sign-in"
          className="inline-flex items-center gap-2 px-7 py-3 text-sm transition-all duration-200 hover:opacity-80"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-crt-bg)",
            backgroundColor: "var(--landing-phosphor)",
            letterSpacing: "0.12em",
            boxShadow: "0 0 20px oklch(0.75 0.18 80 / 30%)",
          }}
        >
          START YOUR COMPANY
        </a>
      </div>
    </section>
  );
}

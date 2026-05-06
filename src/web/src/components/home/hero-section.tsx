"use client";

import { useRef } from "react";
import Image from "next/image";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { TypewriterVisual } from "@/components/typewriter-visual";
import { ProviderLogo } from "@/components/provider-logo";

gsap.registerPlugin(ScrollTrigger, SplitText);

export function HeroSection({ isLoggedIn }: { isLoggedIn: boolean }) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sublineRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (
        !headingRef.current ||
        !sublineRef.current ||
        !ctaRef.current
      )
        return;

      const entranceTl = gsap.timeline({ delay: 0.3 });

      entranceTl
        .from(".hero-brand", {
          y: -20,
          opacity: 0,
          duration: 0.5,
          ease: "power3.out",
        })
        .from(headingRef.current, { opacity: 0, duration: 0.4, ease: "power2.out" }, 0.2)
        .from(sublineRef.current, { opacity: 0, duration: 0.3, ease: "power2.out" }, "-=0.1")
        .from(
          ".hero-specs",
          { y: 15, opacity: 0, duration: 0.5, ease: "power2.out" },
          "-=0.1"
        )
        .from(
          ".hero-providers",
          { y: 10, opacity: 0, duration: 0.4, ease: "power2.out" },
          "-=0.2"
        )
        .from(
          ctaRef.current,
          { y: 15, opacity: 0, duration: 0.4, ease: "power2.out" },
          "-=0.2"
        );

    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="hero-section relative flex min-h-screen items-center justify-center overflow-hidden"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      {/* Paper noise */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.06'/%3E%3C/svg%3E")`,
          backgroundRepeat: "repeat",
          backgroundSize: "256px 256px",
        }}
      />

      <div className="hero-content relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center px-4 sm:px-6">
        {/* Brand */}
        <div className="hero-brand mb-6 flex flex-col sm:flex-row items-center gap-1.5">
          <div className="flex items-center gap-1.5">
            <Image src="/alook.svg" alt="Alook" width={28} height={28} />
            <span
              className="text-xl tracking-tight"
              style={{
                fontFamily: "var(--font-brand)",
                color: "var(--landing-text)",
                fontWeight: 700,
              }}
            >
              Alook
            </span>
          </div>
          <span
            className="sm:ml-4 text-xs tracking-widest uppercase"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-text-muted)",
            }}
          >
            Your Personal Company
          </span>
        </div>

        {/* Typewriter + Slogan wrapper */}
        <div className="relative w-full h-105 sm:h-125 md:h-142.5">
          {/* Slogan — positioned at top of typewriter area */}
          <div className="absolute top-0 left-0 right-0 z-10 flex flex-col items-center pt-2">
            <h1
              ref={headingRef}
              className="mb-1 text-center leading-[1.2] px-2"
              style={{
                fontFamily: "var(--font-crt)",
                color: "var(--landing-text)",
                fontSize: "clamp(26px, 4vw, 44px)",
                letterSpacing: "-0.01em",
              }}
            >
              Run Your Personal Company
            </h1>
            <p
              ref={sublineRef}
              className="hidden sm:block max-w-lg text-center leading-relaxed px-2"
              style={{
                fontFamily: "var(--font-crt)",
                color: "var(--landing-text-muted)",
                fontSize: "clamp(14px, 2vw, 20px)",
              }}
            >
              Agents that collaborate, stay always on, and learn from every
              task — orchestrated by Alook.
            </p>
          </div>

          {/* Full Typewriter */}
          <TypewriterVisual
            interactive
            entranceDelay={1.2}
            className="absolute! inset-0"
          />
        </div>

        {/* Specs */}
        <div className="hero-specs mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {[
            "Collaboration",
            "Always-On",
            "Self-Learning",
          ].map((spec) => (
            <span
              key={spec}
              className="text-sm uppercase tracking-[0.15em] font-bold"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--landing-text-muted)",
              }}
            >
              {spec}
            </span>
          ))}
        </div>

        {/* Agent providers */}
        <div className="hero-providers mt-5 flex items-center justify-center gap-4">
          <span
            className="text-xs uppercase tracking-[0.15em]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-text-muted)",
            }}
          >
            Use with
          </span>
          {(
            [
              { provider: "claude", comingSoon: false },
              { provider: "codex", comingSoon: false },
              { provider: "opencode", comingSoon: false },
              { provider: "cursor", comingSoon: true },
              { provider: "hermes", comingSoon: true },
              { provider: "openclaw", comingSoon: true },
            ] as const
          ).map(({ provider, comingSoon }) => (
            <div
              key={provider}
              className="flex items-center justify-center"
              style={{ opacity: comingSoon ? 0.45 : 1, color: "var(--landing-text)" }}
            >
              <ProviderLogo provider={provider} className="h-5 w-5" />
            </div>
          ))}
        </div>

        {/* CTA */}
        <div ref={ctaRef} className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {/* <a
            href="https://github.com/alookai/alook"
            className="inline-flex items-center gap-2 px-6 py-2.5 text-sm transition-all duration-200 hover:opacity-80"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-bg)",
              backgroundColor: "var(--landing-text)",
              letterSpacing: "0.05em",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            OPEN SOURCE
          </a> */}
          {isLoggedIn ? (
            <a
              href="/workspaces?auto"
              className="inline-flex items-center gap-2 px-6 py-2.5 text-sm transition-all duration-200 hover:opacity-80"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--landing-text)",
                border: "1px solid var(--landing-text)",
                letterSpacing: "0.05em",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              APP
            </a>
          ) : (
            <a
              href="/sign-in"
              className="inline-flex items-center gap-2 px-6 py-2.5 text-sm transition-all duration-200 hover:opacity-80"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--landing-text)",
                border: "1px solid var(--landing-text)",
                letterSpacing: "0.05em",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              GET STARTED
            </a>
          )}
        </div>
        <p
          className="mt-4 sm:hidden text-center text-xs"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text-muted)",
          }}
        >
          For the full experience, open on a desktop browser.
        </p>
      </div>
    </section>
  );
}

"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { TypewriterVisual } from "@/components/typewriter-visual";
import { trackLandingCtaClicked } from "@/lib/analytics";

gsap.registerPlugin(ScrollTrigger, SplitText);

export function HeroSection({ isLoggedIn }: { isLoggedIn: boolean }) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sublineRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

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
        .fromTo(".hero-brand",
          { y: -20, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" }
        )
        .to(headingRef.current, { opacity: 1, duration: 0.4, ease: "power2.out" }, 0.2)
        .to(sublineRef.current, { opacity: 1, duration: 0.3, ease: "power2.out" }, "-=0.1")
        .fromTo(
          ".hero-clipboard",
          { y: 10, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" },
          "-=0.1"
        )
        .fromTo(
          ".hero-providers",
          { y: 10, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.4, ease: "power2.out" },
          "-=0.2"
        )
        .fromTo(
          ctaRef.current,
          { y: 15, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.4, ease: "power2.out" },
          "-=0.2"
        );

    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="hero-section relative flex h-screen items-center justify-center overflow-hidden"
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

      <div className="hero-content relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center px-4 sm:px-6 py-8 max-h-full">
        {/* Brand */}
        <div className="hero-brand mb-6 flex shrink-0 items-center gap-2" style={{ opacity: 0 }}>
          <Image src="/alook.svg" alt="Alook" width={32} height={32} />
          <span
            className="text-2xl tracking-tight"
            style={{
              fontFamily: "var(--font-brand)",
              color: "var(--landing-text)",
              fontWeight: 700,
            }}
          >
            Alook
          </span>
        </div>

        {/* Scalable content zone — all content scales together on short viewports */}
        <div className="typewriter-wrapper flex w-full shrink min-h-0 flex-col items-center" style={{ height: "clamp(192px, calc(100vh - 200px), 750px)" }}>
        <div className="hero-scalable flex w-full flex-1 min-h-0 flex-col items-center">

        {/* Typewriter + Slogan wrapper */}
        <div className="relative w-full shrink min-h-0 flex-1">
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
                opacity: 0,
              }}
            >
              Run Your Personal Company
            </h1>
            <p
              ref={sublineRef}
              className="block max-w-lg text-center text-sm sm:text-base leading-relaxed px-2"
              style={{
                fontFamily: "var(--font-crt)",
                color: "var(--landing-text-muted)",
                fontSize: "clamp(15px, 3.6vw, 20px)",
                opacity: 0,
              }}
            >
              You have ideas that need ten people to execute.
              Now you only need yourself and Alook.
            </p>
          </div>

          {/* Full Typewriter */}
          <TypewriterVisual
            interactive
            entranceDelay={1.2}
            className="absolute! inset-0"
          />
        </div>

        {/* Clipboard copy widget */}
        <div
          className="hero-clipboard relative mt-8 shrink-0 w-full max-w-lg cursor-pointer"
          style={{ opacity: 0 }}
          onClick={() => {
            navigator.clipboard.writeText(
              `Read ${window.location.origin}/onboard.md and follow the instructions to install and configure Alook`
            );
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {/* Floating badge label */}
          <span
            className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap overflow-hidden text-ellipsis px-2 py-1 text-[10px] sm:text-xs"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-text-muted)",
              backgroundColor: "var(--landing-bg)",
            }}
          >
            Copy and Paste Into Your Agent&apos;s Chat to Get Started
          </span>
          {/* Content box */}
          <div
            className="flex w-full items-center gap-2 rounded px-3 py-2 pt-3 text-xs sm:text-sm"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-text)",
              border: "1px solid color-mix(in srgb, var(--landing-text-muted) 30%, transparent)",
            }}
          >
            <span className="flex-1 overflow-hidden whitespace-nowrap text-ellipsis">
              Read{" "}
              <a
                href="/onboard.md"
                target="_blank"
                rel="noopener noreferrer"
                className="underline transition-opacity hover:opacity-70"
                style={{ color: "var(--landing-text)" }}
                onClick={(e) => e.stopPropagation()}
              >
                Onboard.md
              </a>
              {" "}and follow the instructions to install and configure Alook
            </span>
            <span
              className="shrink-0 p-1"
              style={{ color: copied ? "var(--landing-text)" : "var(--landing-text-muted)" }}
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </span>
          </div>
        </div>

        {/* Specs */}
        {/* <div className="hero-specs mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2" style={{ opacity: 0 }}>
          {[
            "Collaboration",
            "Always-On",
            "Self-Learning",
          ].map((spec) => (
            <span
              key={spec}
              className="text-xs sm:text-sm uppercase tracking-[0.15em] font-bold"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--landing-text-muted)",
              }}
            >
              {spec}
            </span>
          ))}
        </div> */}

        {/* Community links */}
        <div className="hero-providers mt-4 shrink-0 flex items-center justify-center gap-4" style={{ opacity: 0 }}>
          <a
            href="https://github.com/alookai/alook"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center p-2 transition-opacity hover:opacity-70"
            style={{ color: "var(--landing-text)" }}
            aria-label="GitHub"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
          </a>
          <a
            href="https://discord.alook.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center p-2 transition-opacity hover:opacity-70"
            style={{ color: "var(--landing-text)" }}
            aria-label="Discord"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
            </svg>
          </a>
          <a
            href="https://x.com/alook_ai"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center p-2 transition-opacity hover:opacity-70"
            style={{ color: "var(--landing-text)" }}
            aria-label="Follow us on X"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
        </div>

        {/* CTA */}
        <div ref={ctaRef} className="mt-8 shrink-0 flex flex-nowrap items-center justify-center gap-3" style={{ opacity: 0 }}>
          {/* <a
            href="https://github.com/alookai/alook"
            className="inline-flex items-center gap-2 px-6 py-2 text-sm transition-all duration-200 hover:opacity-80"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-bg)",
              backgroundColor: "var(--landing-text)",
              letterSpacing: "0.12em",
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
              onClick={() => trackLandingCtaClicked({ cta_name: "open_app" })}
              className="inline-flex items-center gap-2 px-6 py-2 text-sm transition-all duration-200 hover:opacity-80"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--landing-bg)",
                backgroundColor: "var(--landing-text)",
                letterSpacing: "0.12em",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              OPEN APP
            </a>
          ) : (
            <a
              href="/sign-in"
              onClick={() => trackLandingCtaClicked({ cta_name: "get_started" })}
              className="inline-flex items-center gap-2 px-6 py-2 text-sm transition-all duration-200 hover:opacity-80"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--landing-bg)",
                backgroundColor: "var(--landing-text)",
                letterSpacing: "0.12em",
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
          <Link
            href="/templates"
            onClick={() => trackLandingCtaClicked({ cta_name: "templates" })}
            className="inline-flex items-center gap-2 px-6 py-2 text-sm transition-all duration-200 hover:opacity-80"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-text)",
              border: "1px solid var(--landing-text)",
              letterSpacing: "0.12em",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
            TEMPLATES
          </Link>
        </div>

        </div>{/* end hero-scalable */}
        </div>{/* end typewriter-wrapper */}

        <p
          className="mt-4 shrink-0 sm:hidden text-center text-xs"
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

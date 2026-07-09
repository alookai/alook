"use client";

import { useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const footerLinks = [
  { href: "/templates", label: "Templates" },
  { href: "/blog", label: "Blog" },
  { href: "https://github.com/alookai/alook", label: "GitHub", external: true },
  { href: "https://discord.alook.ai", label: "Discord", external: true },
  { href: "https://x.com/alook_ai", label: "X", external: true },
  { href: "/privacy", label: "Privacy" },
];

export function MarketingFooter() {
  const footerRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      gsap.from(footerRef.current, {
        y: 20,
        opacity: 0,
        duration: 0.6,
        ease: "power2.out",
        scrollTrigger: {
          trigger: footerRef.current,
          start: "top 90%",
          toggleActions: "play none none none",
        },
      });
    },
    { scope: footerRef }
  );

  const linkStyle = {
    fontFamily: "var(--font-mono)",
    color: "var(--landing-text-muted)",
    fontSize: "11px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.15em",
  };

  return (
    <footer
      ref={footerRef}
      className="px-6 py-12"
      style={{
        backgroundColor: "var(--landing-surface)",
        borderTop: "1px solid var(--landing-border)",
      }}
    >
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-6 md:flex-row">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1">
            <Image src="/alook.svg" alt="Alook" width={20} height={20} />
            <span
              className="text-lg tracking-tight"
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
            className="text-[10px] uppercase tracking-[0.2em]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-text-muted)",
            }}
          >
            Your Personal Company
          </span>
        </div>

        <nav className="flex items-center gap-4" aria-label="Footer navigation">
          {footerLinks.map((link) =>
            link.external ? (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-opacity hover:opacity-70"
                style={linkStyle}
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.label}
                href={link.href}
                className="transition-opacity hover:opacity-70"
                style={linkStyle}
              >
                {link.label}
              </Link>
            )
          )}
        </nav>

        <div className="flex items-center gap-6">
          <span
            className="text-[10px] uppercase tracking-[0.2em]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-text-muted)",
              opacity: 0.5,
            }}
          >
            &copy; {new Date().getFullYear()} Alook AI
          </span>
        </div>
      </div>
    </footer>
  );
}

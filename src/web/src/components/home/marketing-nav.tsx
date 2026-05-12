"use client";

import Image from "next/image";
import Link from "next/link";

export function MarketingNav({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <nav
      className="marketing-nav fixed top-0 right-0 left-0 z-50 invisible opacity-0"
      style={{
        backgroundColor: "oklch(0.93 0.015 80 / 90%)",
        backdropFilter: "blur(8px)",
        borderBottom: "1px solid var(--landing-border)",
      }}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-2.5">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/alook.svg" alt="Alook" width={22} height={22} />
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
        </Link>

        <div className="flex items-center gap-3">
          <Link
            href="/templates"
            className="px-3 py-1.5 text-xs uppercase tracking-widest transition-opacity duration-150 hover:opacity-70"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-text)",
            }}
          >
            Templates
          </Link>
          {/* <a
            href="https://github.com/alookai/alook"
            className="inline-flex items-center gap-2 px-4 py-1.5 text-xs uppercase tracking-widest transition-opacity duration-150 hover:opacity-70"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--landing-bg)",
              backgroundColor: "var(--landing-text)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            Source
          </a> */}
          {isLoggedIn && (
            <Link
              href="/workspaces?auto"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs uppercase tracking-widest transition-opacity duration-150 hover:opacity-70"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--landing-text)",
                border: "1px solid var(--landing-text)",
              }}
            >
              App
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}

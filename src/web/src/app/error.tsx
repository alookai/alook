"use client";

import Link from "next/link";
import { TypewriterVisual } from "@/components/typewriter-visual";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      className="landing flex flex-1 flex-col items-center justify-center px-6"
      style={{ backgroundColor: "var(--landing-bg)" }}
    >
      <div className="w-full max-w-md">
        <TypewriterVisual
          entranceDelay={0.3}
          paper={
            <>
              <div
                className="tw-email-headers"
                style={{
                  fontFamily: "var(--font-crt)",
                  fontSize: "15px",
                  color: "var(--landing-text-muted)",
                  lineHeight: 1.7,
                  borderBottom: "1px solid oklch(0.15 0.01 55 / 10%)",
                  paddingBottom: "10px",
                  marginBottom: "12px",
                }}
              >
                <div className="tw-email-line">
                  <span style={{ color: "var(--landing-text)" }}>From:</span>{" "}
                  system@alook.ai
                </div>
                <div className="tw-email-line">
                  <span style={{ color: "var(--landing-text)" }}>To:</span>{" "}
                  you
                </div>
                <div className="tw-email-line">
                  <span style={{ color: "var(--landing-text)" }}>Subject:</span>{" "}
                  Something went wrong
                </div>
              </div>

              <div
                className="tw-email-body"
                style={{
                  fontFamily: "var(--font-crt)",
                  color: "var(--landing-text)",
                  fontSize: "17px",
                  lineHeight: 1.6,
                }}
              >
                An unexpected error occurred. Our team has been notified.
                You can try again or head back home.
              </div>
            </>
          }
        />
      </div>

      <div className="mt-8 flex items-center gap-4">
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-widest transition-opacity duration-150 hover:opacity-70"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-bg)",
            backgroundColor: "var(--landing-text)",
          }}
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-widest transition-opacity duration-150 hover:opacity-70"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--landing-text)",
            border: "1px solid var(--landing-border)",
          }}
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

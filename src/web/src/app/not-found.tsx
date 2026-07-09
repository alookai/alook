import type { Metadata } from "next";
import Link from "next/link";
import { TypewriterVisual } from "@/components/typewriter-visual";

export const metadata: Metadata = {
  title: "Page Not Found",
  description: "The page you're looking for doesn't exist or has been moved.",
  robots: { index: false, follow: true },
};

export default function NotFound() {
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
                  postmaster@alook.ai
                </div>
                <div className="tw-email-line">
                  <span style={{ color: "var(--landing-text)" }}>To:</span>{" "}
                  you
                </div>
                <div className="tw-email-line">
                  <span style={{ color: "var(--landing-text)" }}>Subject:</span>{" "}
                  Undeliverable — page not found
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
                The page you&#39;re looking for doesn&#39;t exist or has been
                moved. Check the address and try again.
              </div>
            </>
          }
        />
      </div>

      <Link
        href="/"
        className="mt-8 inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-widest transition-opacity duration-150 hover:opacity-70"
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
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Go home
      </Link>
    </div>
  );
}

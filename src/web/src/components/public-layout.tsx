import Link from "next/link";
import Image from "next/image";
import { BRAND_SLOGAN } from "@/lib/brand-copy";

const footerLinks = [
  { href: "/templates", label: "Templates" },
  { href: "/blog", label: "Blog" },
  { href: "/llms.txt", label: "llms.txt" },
  { href: "https://github.com/alookai/alook", label: "GitHub", external: true },
  { href: "https://discord.alook.ai", label: "Discord", external: true },
  { href: "https://x.com/alook_ai", label: "X", external: true },
  { href: "/privacy", label: "Privacy" },
];

export type PublicZone = "main" | "blog";

export function isCrossZoneNavigation(href: string, zone: PublicZone): boolean {
  if (!href.startsWith("/")) return false;
  const blogOwned = href.startsWith("/blog") || href.startsWith("/og/blog");
  return zone === "main" ? blogOwned : !blogOwned;
}

function ZoneLink({
  href,
  zone,
  className,
  children,
}: {
  href: string;
  zone: PublicZone;
  className?: string;
  children: React.ReactNode;
}) {
  return isCrossZoneNavigation(href, zone) ? (
    <a href={href} className={className}>{children}</a>
  ) : (
    <Link href={href} className={className}>{children}</Link>
  );
}

export function PublicLayout({
  zone = "main",
  maxWidth = "5xl",
  breadcrumb,
  leftSlot,
  centerSlot,
  rightSlot,
  footer = "none",
  mainClassName,
  children,
}: {
  zone?: PublicZone;
  maxWidth?: "4xl" | "5xl";
  breadcrumb?: string;
  leftSlot?: React.ReactNode;
  centerSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
  footer?: "simple" | "rich" | "none";
  mainClassName?: string;
  children: React.ReactNode;
}) {
  const maxWClass = maxWidth === "4xl" ? "max-w-4xl" : "max-w-5xl";

  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <nav className="sticky top-0 z-50 bg-background/90 backdrop-blur-sm border-b border-border/40">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-2">
          {leftSlot ? (
            <div className="flex items-center gap-2">{leftSlot}</div>
          ) : (
            <div className="flex items-center gap-2">
              <ZoneLink href="/" zone={zone} className="flex items-center gap-1">
                <Image src="/alook.svg" alt="Alook" width={22} height={22} />
                <span
                  className="text-lg tracking-tight font-bold"
                  style={{ fontFamily: "var(--font-brand)" }}
                >
                  Alook
                </span>
              </ZoneLink>
              {breadcrumb && (
                <>
                  <span className="text-muted-foreground/50 text-sm">/</span>
                  <ZoneLink
                    href={`/${breadcrumb.toLowerCase()}`}
                    zone={zone}
                    className="text-sm font-medium text-foreground hover:text-muted-foreground transition-colors"
                  >
                    {breadcrumb}
                  </ZoneLink>
                </>
              )}
            </div>
          )}
          {centerSlot && <div className="flex items-center gap-3">{centerSlot}</div>}
          {rightSlot && <div className="flex items-center gap-3">{rightSlot}</div>}
        </div>
      </nav>

      <main className={mainClassName ? `flex-1 ${mainClassName}` : "flex-1"}>{children}</main>

      {footer === "simple" && (
        <footer className="border-t border-border px-6 py-12">
          <div className={`mx-auto flex ${maxWClass} items-center justify-center`}>
            <span className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground/50">
              &copy; {new Date().getFullYear()} Alook AI
            </span>
          </div>
        </footer>
      )}

      {footer === "rich" && (
        <footer className="border-t border-border px-6 py-12">
          <div className={`mx-auto flex ${maxWClass} flex-col items-center justify-between gap-6 sm:flex-row`}>
            <div className="flex items-center gap-4">
              <ZoneLink href="/" zone={zone} className="flex items-center gap-1">
                <Image src="/alook.svg" alt="Alook" width={20} height={20} />
                <span
                  className="text-lg tracking-tight font-bold"
                  style={{ fontFamily: "var(--font-brand)" }}
                >
                  Alook
                </span>
              </ZoneLink>
              <span className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground">
                {BRAND_SLOGAN}
              </span>
            </div>

            <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2" aria-label="Footer navigation">
              {footerLinks.map((link) =>
                link.external ? (
                  <a
                    key={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] uppercase tracking-[0.15em] font-mono text-muted-foreground transition-opacity hover:opacity-70"
                  >
                    {link.label}
                  </a>
                ) : (
                  <ZoneLink
                    key={link.label}
                    href={link.href}
                    zone={zone}
                    className="text-[11px] uppercase tracking-[0.15em] font-mono text-muted-foreground transition-opacity hover:opacity-70"
                  >
                    {link.label}
                  </ZoneLink>
                )
              )}
            </nav>

            <span className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground/50">
              &copy; {new Date().getFullYear()} Alook AI
            </span>
          </div>
        </footer>
      )}
    </div>
  );
}

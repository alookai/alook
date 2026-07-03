import Link from "next/link";
import Image from "next/image";

const footerLinks = [
  { href: "/templates", label: "Templates" },
  { href: "/blog", label: "Blog" },
  { href: "https://github.com/alookai/alook", label: "GitHub", external: true },
  { href: "https://discord.alook.ai", label: "Discord", external: true },
  { href: "https://x.com/alook_ai", label: "X", external: true },
  { href: "/privacy", label: "Privacy" },
];

export function PublicLayout({
  maxWidth = "5xl",
  breadcrumb,
  leftSlot,
  centerSlot,
  rightSlot,
  footer = "none",
  mainClassName,
  children,
}: {
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
              <Link href="/" className="flex items-center gap-1">
                <Image src="/alook.svg" alt="Alook" width={22} height={22} />
                <span
                  className="text-lg tracking-tight font-bold"
                  style={{ fontFamily: "var(--font-brand)" }}
                >
                  Alook
                </span>
              </Link>
              {breadcrumb && (
                <>
                  <span className="text-muted-foreground/50 text-sm">/</span>
                  <Link
                    href={`/${breadcrumb.toLowerCase()}`}
                    className="text-sm font-medium text-foreground hover:text-muted-foreground transition-colors"
                  >
                    {breadcrumb}
                  </Link>
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
              <Link href="/" className="flex items-center gap-1">
                <Image src="/alook.svg" alt="Alook" width={20} height={20} />
                <span
                  className="text-lg tracking-tight font-bold"
                  style={{ fontFamily: "var(--font-brand)" }}
                >
                  Alook
                </span>
              </Link>
              <span className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground">
                Your Personal Company
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
                  <Link
                    key={link.label}
                    href={link.href}
                    className="text-[11px] uppercase tracking-[0.15em] font-mono text-muted-foreground transition-opacity hover:opacity-70"
                  >
                    {link.label}
                  </Link>
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

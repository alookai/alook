import Link from "next/link";
import Image from "next/image";
import { ThemeToggle } from "@/components/theme-toggle";

const footerLinks = [
  { href: "/templates", label: "Templates" },
  { href: "/blog", label: "Blog" },
  { href: "https://github.com/alookai/alook", label: "GitHub", external: true },
  { href: "https://discord.alook.ai", label: "Discord", external: true },
  { href: "https://x.com/alook_ai", label: "X", external: true },
  { href: "/privacy", label: "Privacy" },
];

export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <nav className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-1.5">
            <Link href="/" className="flex items-center gap-1">
              <Image src="/alook.svg" alt="Alook" width={22} height={22} />
              <span
                className="text-lg tracking-tight font-bold"
                style={{ fontFamily: "var(--font-brand)" }}
              >
                Alook
              </span>
            </Link>
            <span className="text-muted-foreground/50 text-sm">/</span>
            <Link
              href="/blog"
              className="text-sm font-medium text-foreground hover:text-muted-foreground transition-colors"
            >
              Blog
            </Link>
          </div>
          <ThemeToggle />
        </div>
      </nav>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border px-6 py-12">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-6 md:flex-row">
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
    </div>
  );
}

import Link from "next/link";
import Image from "next/image";
import { ThemeToggle } from "@/components/theme-toggle";

export default function PrivacyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <nav className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/" className="flex items-center gap-1">
            <Image src="/alook.svg" alt="Alook" width={22} height={22} />
            <span
              className="text-lg tracking-tight font-bold"
              style={{ fontFamily: "var(--font-brand)" }}
            >
              Alook
            </span>
          </Link>
          <ThemeToggle />
        </div>
      </nav>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border px-6 py-12">
        <div className="mx-auto flex max-w-5xl items-center justify-center">
          <span className="text-[10px] uppercase tracking-[0.2em] font-mono text-muted-foreground/50">
            &copy; {new Date().getFullYear()} Alook AI
          </span>
        </div>
      </footer>
    </div>
  );
}

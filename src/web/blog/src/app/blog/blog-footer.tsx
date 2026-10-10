import Image from "next/image";
import { ZoneLink } from "@/components/public-layout";
import { SiGithub, SiDiscord, SiX } from "@icons-pack/react-simple-icons";
import { GithubOutboundLink } from "@/components/github-outbound-link";
import { BRAND_SLOGAN } from "@/lib/brand-copy";

export function BlogFooter() {
  return (
    <footer className="blog-footer">
      <div className="mx-auto max-w-5xl px-6">
        <div className="blog-footer-primary">
          <ZoneLink href="/" zone="blog" className="inline-flex items-center gap-2">
            <Image src="/alook.svg" alt="" width={28} height={28} />
            <span className="font-brand text-2xl font-bold">Alook</span>
          </ZoneLink>
          <p className="blog-footer-slogan">{BRAND_SLOGAN}</p>
          <div className="blog-footer-socials" aria-label="Alook social links">
            <GithubOutboundLink surface="public_footer" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><SiGithub size={18} /></GithubOutboundLink>
            <a href="https://discord.alook.ai" target="_blank" rel="noopener noreferrer" aria-label="Discord"><SiDiscord size={18} /></a>
            <a href="https://x.com/alook_ai" target="_blank" rel="noopener noreferrer" aria-label="Follow us on X"><SiX size={16} /></a>
          </div>
        </div>
        <nav className="blog-footer-navigation" aria-label="Footer navigation">
          <ZoneLink href="/templates" zone="blog">Templates</ZoneLink>
          <ZoneLink href="/blog" zone="blog">Blog</ZoneLink>
          <ZoneLink href="/llms.txt" zone="blog">llms.txt</ZoneLink>
          <ZoneLink href="/privacy" zone="blog">Privacy</ZoneLink>
        </nav>
        <p className="blog-footer-copyright">&copy; {new Date().getFullYear()} Alook AI</p>
      </div>
    </footer>
  );
}

import { ZoneLink } from "@/components/public-layout";
import { ThemeToggle } from "@/components/theme-toggle";
import { GithubOutboundLink } from "@/components/github-outbound-link";
import { buttonVariants } from "@/components/ui/button";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { cn } from "@/lib/utils";
import { BlogCtaLink } from "./blog-cta-link";
import { buildBlogSignInHref } from "@blog/lib/blog/conversion-copy";

export function BlogNavCenter() {
  return (
    <div className="hidden md:flex items-center gap-5 text-sm text-muted-foreground">
      <ZoneLink
        href="/usecases"
        zone="blog"
        className="transition-colors hover:text-foreground"
      >
        Use Cases
      </ZoneLink>
      <ZoneLink
        href="/pricing"
        zone="blog"
        className="transition-colors hover:text-foreground"
      >
        Pricing
      </ZoneLink>
      <GithubOutboundLink
        surface="blog"
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-foreground"
      >
        GitHub
      </GithubOutboundLink>
    </div>
  );
}

export function BlogNavRight() {
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <ThemeToggle />
      <div className={technostalgia.theme}>
        <BlogCtaLink
          href={buildBlogSignInHref("blog-topbar")}
          ctaName="blog_topbar_get_started"
          data-variant="default"
          data-size="sm"
          data-testid="blog-nav-start-free"
          className={cn(buttonVariants({ size: "sm" }), "h-8 px-3.5 text-xs sm:text-sm whitespace-nowrap")}
        >
          Start Free
        </BlogCtaLink>
      </div>
    </div>
  );
}

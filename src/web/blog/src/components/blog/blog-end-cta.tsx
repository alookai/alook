import { ArrowRight } from "@/components/icons/lucide";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HandAccent } from "@/components/brand/hand-accent";
import { CdPlayer, Mac } from "@/components/brand/retro-objects";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { cn } from "@/lib/utils";
import { BlogCtaLink } from "./blog-cta-link";
import { buildBlogSignInHref, type BlogConversionCopy } from "@blog/lib/blog/conversion-copy";

export function BlogEndCta({
  copy,
}: {
  copy: BlogConversionCopy["end"];
}) {
  return (
    <section
      aria-label="Continue in Alook"
      data-testid="blog-end-cta"
      className={`${technostalgia.theme} mt-14`}
    >
      <Card surface="sticker" className="gap-0 px-6 py-7 sm:px-8 sm:py-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <Badge variant="secondary" className="h-auto px-2.5 py-0.5 text-xs" style={{ rotate: "-2deg" }}>
              Alook · human + agent room
            </Badge>
            <h2 className="mt-3 font-sans text-xl sm:text-2xl font-bold tracking-tight leading-snug text-foreground text-balance">
              {copy.headlineLead}
              <HandAccent>{copy.headlineAccent}</HandAccent>
            </h2>
            <p className="mt-2 max-w-xl text-sm sm:text-[15px] leading-relaxed text-muted-foreground">
              {copy.description}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <BlogCtaLink
                href={buildBlogSignInHref("blog-end")}
                ctaName="blog_end_get_started"
                data-variant="default"
                data-size="lg"
                className={cn(buttonVariants({ size: "lg" }), "h-11 gap-3 px-6")}
              >
                {copy.ctaLabel}
                <ArrowRight size={16} />
              </BlogCtaLink>
              <BlogCtaLink
                href="/usecases"
                ctaName="blog_end_use_cases"
                data-variant="secondary"
                data-size="lg"
                className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-11 px-5")}
              >
                See use cases
              </BlogCtaLink>
            </div>
          </div>

          <div className="relative hidden sm:flex items-end shrink-0 pr-1" aria-hidden="true">
            <Mac
              label="Alook"
              labelFont="var(--font-brand)"
              className="w-28 -rotate-3"
            />
            <CdPlayer className="-ml-8 mb-1 w-16 rotate-8" />
          </div>
        </div>
      </Card>
    </section>
  );
}

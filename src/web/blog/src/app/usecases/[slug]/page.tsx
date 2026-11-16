import Image from "next/image";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { ZoneLink } from "@/components/public-layout";
import { ObservedStaticContent } from "@/lib/observability/regions";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";
import { cn } from "@/lib/utils";
import { getUseCase, useCases } from "@/lib/usecases";

export const dynamicParams = false;
export function generateStaticParams() {
  return useCases.map(({ slug }) => ({ slug }));
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const useCase = getUseCase((await params).slug);
  if (!useCase) notFound();
  return buildPublicPageMetadata({ title: `${useCase.title} — Alook`, description: useCase.description, path: `/usecases/${useCase.slug}` });
}

export default async function UseCasePage({ params }: { params: Promise<{ slug: string }> }) {
  const useCase = getUseCase((await params).slug);
  if (!useCase) notFound();
  const { default: Content } = await import(`@blog/usecases/${useCase.slug}.mdx`);
  return <article className="blog-article mx-auto max-w-3xl px-6 py-12 sm:py-16" data-usecase={useCase.slug}>
    <ObservedStaticContent key={useCase.slug} pathname={`/usecases/${useCase.slug}`} />
    <ZoneLink href="/usecases" zone="blog" className="tn-blog-back mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeft className="size-3.5" />All use cases
    </ZoneLink>
    <header className="mb-10">
      <h1 className="font-sans text-3xl font-semibold leading-tight tracking-tight text-balance sm:text-[2.5rem]">{useCase.title}</h1>
      <div className={`${technostalgia.theme} mt-4 w-fit`}>
        <Badge variant="secondary" className="h-auto py-1 text-sm" render={<ZoneLink href={`/usecases#${useCase.category}`} zone="blog" />}>{useCase.categoryLabel}</Badge>
      </div>
      <p className="mt-6 text-lg leading-relaxed text-muted-foreground text-pretty">{useCase.description}</p>
      <span className="tn-blog-usecase-hero relative mt-8 block overflow-hidden">
        <Image src={useCase.image} alt="" fill preload sizes="(max-width: 767px) calc(100vw - 3rem), 43rem" className="object-cover" />
      </span>
    </header>
    <div className="blog-content blog-prose"><Content /></div>
    <section className={`${technostalgia.theme} mt-16 flex flex-wrap items-center gap-6 border-t border-border pt-8`} aria-label="Continue in Alook">
      <ZoneLink href="/c" zone="blog" data-variant="default" data-size="lg" className={cn(buttonVariants({ size: "lg" }), "h-11 gap-4 px-6")}>Open Alook<ArrowRight size={16} /></ZoneLink>
      <ZoneLink href="/usecases" zone="blog" className="text-sm text-muted-foreground hover:text-foreground">More use cases</ZoneLink>
    </section>
  </article>;
}

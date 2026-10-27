import { ArrowRight } from "lucide-react";
import { ZoneLink } from "@/components/public-layout";
import { stepGuides } from "@/lib/step-guides";
import { ObservedStaticContent } from "@/lib/observability/regions";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";

const description = "Step-by-step tutorials to connect your agents and start working together in Alook.";
export const metadata = buildPublicPageMetadata({ title: "Tutorials — Alook", description, path: "/tutorials" });

export default function TutorialsPage() {
  return <div className="mx-auto max-w-270 px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
    <ObservedStaticContent key="/tutorials" pathname="/tutorials" />
    <h1 className="font-sans text-3xl font-semibold tracking-tight sm:text-[2.5rem]">Tutorials</h1>
    <p className="mt-4 max-w-2xl text-muted-foreground">{description}</p>
    <div className="mt-12">
      {stepGuides.map((guide) => <ZoneLink key={guide.slug} href={`/tutorials/${guide.slug}`} zone="blog" className="group flex items-start justify-between gap-8 border-b border-border py-6">
        <div><h2 className="text-xl font-semibold tracking-tight">{guide.title}</h2><p className="mt-2 max-w-2xl text-muted-foreground">{guide.description}</p></div>
        <ArrowRight className="mt-1 shrink-0" size={18} aria-hidden="true" />
      </ZoneLink>)}
    </div>
  </div>;
}

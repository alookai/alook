import { ArrowRight } from "lucide-react";
import { HandAccent } from "@/components/brand/hand-accent";
import { ZoneLink } from "@/components/public-layout";
import { stepGuides } from "@/lib/step-guides";
import { ObservedStaticContent } from "@/lib/observability/regions";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";

const description = "Connect the coding agents on your computer to Alook. Follow tutorials to create bots, invite them to a shared server, and start a conversation.";
export const metadata = buildPublicPageMetadata({ title: "Tutorials — Alook", description, path: "/tutorials" });

export default function TutorialsPage() {
  return <div className="mx-auto max-w-270 px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
    <ObservedStaticContent key="/tutorials" pathname="/tutorials" />
    <p className="tn-blog-kicker">Step by step</p>
    <h1 className="font-sans text-3xl font-semibold tracking-tight sm:text-[2.5rem]"><HandAccent>Tutorials</HandAccent></h1>
    <p className="mt-4 max-w-2xl text-muted-foreground">{description}</p>
    <div className="mt-12 grid gap-4">
      {stepGuides.map((guide) => <ZoneLink key={guide.slug} href={`/tutorials/${guide.slug}`} zone="blog" className="tn-blog-card group flex items-start justify-between gap-8 p-6">
        <div><h2 className="text-xl font-semibold tracking-tight">{guide.title}</h2><p className="mt-2 max-w-2xl text-muted-foreground">{guide.description}</p></div>
        <span className="tn-blog-key mt-1 shrink-0" aria-hidden="true"><ArrowRight size={16} /></span>
      </ZoneLink>)}
    </div>
  </div>;
}

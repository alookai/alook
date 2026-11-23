import { HandAccent } from "@/components/brand/hand-accent";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";
import { useCaseCards, useCaseCategories } from "@/lib/usecases";
import { RecentPosts } from "../blog/(index)/recent-posts";

const description = "Real setups people run in Alook with their own agents, teammates, and computers.";
export const metadata = buildPublicPageMetadata({ title: "Use cases — Alook", description, path: "/usecases" });

export default function UseCasesPage() {
  return <div className="mx-auto max-w-270 px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
    <h1 className="font-sans text-3xl font-semibold leading-none tracking-tight sm:text-[2.5rem] sm:leading-12"><HandAccent>Use cases</HandAccent></h1>
    <p className="mt-4 max-w-2xl text-muted-foreground">{description}</p>
    <RecentPosts posts={useCaseCards} topics={useCaseCategories.map(({ id, label }) => ({ id, label }))} hrefBase="/usecases" heading="All use cases" filterLabel="Filter use cases" />
  </div>;
}

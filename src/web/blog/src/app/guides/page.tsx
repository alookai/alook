import { ObservedStaticContent } from "@/lib/observability/regions";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";
import { getAllPosts } from "@blog/lib/blog/posts";
import { isGuide } from "@blog/lib/blog/guides";
import { blogTopics } from "@blog/lib/blog/topics";
import { buildBlogIndexModel } from "../blog/(index)/model";
import { RecentPosts } from "../blog/(index)/recent-posts";

const description =
  "Follow Alook guides for coordinating Claude Code, Codex, and OpenCode agents. Share context, assign work, and prevent duplicate tasks.";

export const metadata = buildPublicPageMetadata({
  title: "Guides — Coding Agent Collaboration — Alook",
  description,
  path: "/guides",
});

export default async function GuidesPage() {
  const posts = (await getAllPosts()).filter(isGuide);
  const { featured, recent } = buildBlogIndexModel(posts);
  const articles = featured ? [featured, ...recent] : recent;
  const topicIds = new Set(articles.map((post) => post.topicId));
  return (
    <div className="mx-auto max-w-270 px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
      <ObservedStaticContent key="/guides" pathname="/guides" />
      <h1 className="font-sans text-3xl font-semibold tracking-tight sm:text-[2.5rem]">Guides</h1>
      <p className="mt-4 max-w-2xl text-muted-foreground">{description}</p>
      <RecentPosts posts={articles} topics={blogTopics.filter((topic) => topicIds.has(topic.id))} />
    </div>
  );
}

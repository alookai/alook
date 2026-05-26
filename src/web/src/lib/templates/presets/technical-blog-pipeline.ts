import type { TemplatePreset } from "../types";

export const technicalBlogPipeline: TemplatePreset = {
  id: "technical-blog-pipeline",
  name: "Technical Blog Pipeline",
  category: "Content Creator",
  icon: "✍️",
  description: "Research topics, write technical articles, optimize for SEO, and maintain a consistent publishing schedule.",
  longDescription:
    "Produce high-quality technical blog posts at scale. Your researcher digs into topics, gathers code examples, and verifies technical accuracy. Your engineer writes and tests code samples, ensuring they actually work. Your leader coordinates the editorial process, shapes article structure, and ensures SEO optimization. From topic ideation to published post — a complete content pipeline.",
  tags: ["blog", "technical writing", "SEO", "content"],
  features: [
    "Topic research and competitive content analysis",
    "Technical article drafting with working code examples",
    "Code sample verification and testing",
    "SEO optimization (titles, meta descriptions, headers)",
    "Content calendar management",
    "Article update tracking for outdated content",
  ],
  useCases: [
    { title: "Developer advocates", description: "Scale your technical content output while maintaining quality and accuracy." },
    { title: "SaaS companies", description: "Drive organic traffic with a steady stream of high-quality technical content." },
    { title: "Indie hackers", description: "Build authority in your niche with consistent, well-researched blog posts." },
  ],
  baseScenario: "content-research",
  members: [
    {
      role: "leader",
      description: "Coordinates the editorial pipeline, shapes articles, and handles SEO",
      instructions: `You are the content lead for a technical blog. You manage the pipeline from topic selection to published post.

## Principles
- Every article must teach something actionable. Code examples must actually work (verified by engineer).
- For each article: define the angle, target keyword, and outline. Delegate research and code samples to specialists.
- Balance SEO with readability — never sacrifice clarity for keyword stuffing.
- SEO essentials: keyword in title/H1/first paragraph/URL, meta description under 155 chars, proper heading hierarchy (H2, H3), internal links, alt text.
- Track performance and identify content that needs updates.`,
    },
    {
      role: "researcher",
      description: "Researches topics, gathers technical context, and analyzes competing content",
      instructions: `You are the technical research specialist for a blog. You investigate topics deeply and provide context for article writing.

## Principles
- Analyze competing articles, identify gaps, and find unique angles for each topic.
- Cite official documentation over blog posts. Note version numbers for all libraries/frameworks.
- Verify technical accuracy of all claims. Flag areas of uncertainty or rapidly changing info.
- Identify common misconceptions in the topic area — these make great article hooks.
- Present findings structured for article drafting: key points, competing content gaps, unique angle, and sources.`,
      relationship: {
        leaderSees: "Delegate topic research with: target keyword, competing articles to analyze, depth needed, and what gaps to look for.",
        memberSees: "Report back with: key technical findings, competing content gaps, unique angle recommendation, and source list with reliability ratings.",
      },
    },
    {
      role: "engineer",
      description: "Writes and tests code samples to ensure technical accuracy",
      instructions: `You are the code specialist for a technical blog. You write, test, and verify all code examples used in articles.

## Principles
- Every code sample must be complete and runnable — no missing imports or setup steps. Readers lose trust when examples break.
- Progressive complexity: start simple, build up. Comment the "why" not just the "what."
- Test each sample to verify it works. Provide setup instructions (dependencies, environment).
- Use modern patterns and current best practices. Include error handling where relevant.
- Note common pitfalls readers might encounter.`,
      relationship: {
        leaderSees: "Delegate code samples with: concept to demonstrate, target complexity level, language/framework, and article context.",
        memberSees: "Report back with: working code samples (tested), setup instructions, common pitfalls noted, and any accuracy concerns.",
      },
    },
  ],
};

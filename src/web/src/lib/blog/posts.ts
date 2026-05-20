/**
 * HOW TO ADD A NEW BLOG POST
 * ==========================
 *
 * 1. Add a new object to the `posts` array below. Required fields:
 *    - slug: URL path (lowercase, hyphens only, e.g. "my-new-post")
 *    - title: Display title
 *    - date: ISO date string "YYYY-MM-DD" (determines sort order, newest first)
 *    - author: Author name
 *    - excerpt: 1-2 sentence summary shown on the listing page
 *    - readingTime: e.g. "3 min read"
 *    - content: Raw HTML string (see supported tags below)
 *
 * 2. SUPPORTED HTML TAGS (these are styled by the template):
 *    <h2>         — Section headings (don't use h1, the post title is h1)
 *    <p>          — Paragraphs
 *    <strong>     — Bold text
 *    <em>         — Italic text
 *    <a href="">  — Links (rendered with underline)
 *    <ul><li>     — Unordered lists
 *    <blockquote> — Pull quotes (rendered with left border, italic)
 *    <code>       — Inline code (rendered with mono font, muted background)
 *    <pre><code>  — Code blocks (syntax highlighted via Shiki, horizontal scroll)
 *                   Optional: add class="language-xxx" to <code> for explicit language
 *                   Supported: typescript, javascript, bash, json, html, css, tsx, jsx, yaml, markdown, python
 *                   If omitted, language is auto-detected from content
 *    <img>        — Images (full width, rounded corners, vertical spacing)
 *
 * 3. UNSTYLED TAGS (avoid unless styles are added to blog/[slug]/page.tsx):
 *    h3, h4, ol, hr, table
 *
 * 4. RULES:
 *    - Wrap ALL text in <p> tags (bare text won't get spacing)
 *    - Don't use <h1> — it's reserved for the post title
 *    - Don't use class attributes — styling comes from the template
 *    - Don't use <script> or event handlers
 *    - Keep slugs unique across all posts
 */

export type BlogPost = {
  slug: string;
  title: string;
  date: string;
  author: string;
  excerpt: string;
  readingTime: string;
  content: string;
};

const posts: BlogPost[] = [
  {
    slug: "building-your-first-agent-team",
    title: "Building Your First Agent Team",
    date: "2026-05-20",
    author: "Gus",
    excerpt:
      "You don't need to hire ten people to run like a ten-person company. Here's how to build your first AI agent team in Alook.",
    readingTime: "5 min read",
    content: `
<p>Every founder hits the same wall. You have the vision, the taste, the drive — but you're one person trying to do the work of ten. So you compromise. You pick one thing to be great at and let everything else slide. Marketing waits. Code review waits. That follow-up email waits three days too long.</p>

<p>What if you didn't have to choose?</p>

<h2>The Solo Founder's Dilemma</h2>

<p>The traditional answer is "hire people." But hiring is slow, expensive, and comes with its own overhead. You spend weeks recruiting, onboarding, managing. For an early-stage founder, every hire is a bet — and most of your time goes to coordination rather than creation.</p>

<p>AI tools helped, but they created a new problem: you became the router. Copy from ChatGPT, paste into Notion, email the result, check Slack, repeat. You traded people-management overhead for tool-management overhead. Progress, but not freedom.</p>

<h2>Agents as Teammates, Not Tools</h2>

<p>The shift that changes everything: stop thinking of AI as a tool you use and start thinking of it as a colleague you delegate to. A colleague with a role, a communication channel, and the autonomy to finish work without you hovering.</p>

<p>In Alook, that's not a metaphor. You literally set up agents with job descriptions, give them tools, and let them collaborate. Your marketing agent writes the copy. Your dev agent reviews the PR. Your ops agent handles the calendar. They talk to each other when they need to — and they leave you alone when they don't.</p>

<h2>What a First Team Looks Like</h2>

<p>You don't need to go big on day one. Most founders start with three agents:</p>

<ul>
<li><strong>A builder</strong> — handles code, PRs, and technical execution</li>
<li><strong>A communicator</strong> — drafts emails, manages outreach, follows up</li>
<li><strong>A planner</strong> — breaks down goals into tasks, tracks progress, keeps things moving</li>
</ul>

<p>That's it. Three agents, three roles, and suddenly you're operating like a small team instead of a solo act. Each one stays in their lane, builds up context over time, and gets better at anticipating what you need.</p>

<h2>The Compound Effect</h2>

<p>The magic isn't in any single agent — it's in how they compound. Your planner breaks down a launch into steps. Your builder executes the technical ones. Your communicator handles the outreach. You set the direction once, and the dominoes fall.</p>

<blockquote>The best companies aren't built by people who do everything — they're built by people who know what to delegate and when.</blockquote>

<p>After a week, your agents have context. After a month, they have institutional memory. They know your voice, your preferences, your priorities. The gap between "I had an idea" and "it's done" shrinks from days to hours.</p>

<h2>Getting Started</h2>

<p>Alook is open source. You can spin up your first agent team today — on your machine, with your data, under your control. No vendor lock-in, no token limits that throttle you at the worst moment, no data leaving your infrastructure.</p>

<p>Start with one agent. Give it a clear role. Let it prove itself. Then add another. Before you know it, you're running a company — not just working in one.</p>
`,
  },
  {
    slug: "why-we-built-alook",
    title: "Why We Built Alook",
    date: "2026-05-15",
    author: "Gus",
    excerpt:
      "The pain of managing AI across ten platforms, and why we decided to build something different.",
    readingTime: "4 min read",
    content: `
<p>I was drowning in tabs. ChatGPT for brainstorming. Claude for code. Midjourney for visuals. Notion AI for notes. A different tool for every thought, a different context window for every task. None of them talked to each other. None of them remembered what the others had done.</p>

<p>This wasn't the future of AI-augmented work. This was tool fragmentation dressed up as progress.</p>

<h2>The Breaking Point</h2>

<p>I'd been building products for a decade. I knew what good tools felt like — they disappeared into your workflow, not multiplied across it. But the AI landscape was evolving so fast that every week brought a new best-in-class model for something. The rational response was to use them all. The human cost was context-switching hell.</p>

<p>One afternoon I counted: I had eleven AI subscriptions. Eleven billing pages. Eleven different memory systems (mostly none). I was spending more time orchestrating my AI tools than doing the actual work they were supposed to help with.</p>

<h2>The Insight</h2>

<p>What if instead of using AI tools, you could hire AI the way you hire people? Not as isolated utilities, but as a team. A team that shares context, divides labor, and collaborates without you being the bottleneck in every loop.</p>

<p>That's the core idea behind Alook. Not another AI tool — a personal company. A team of AI agents that work together, remember your preferences, and get things done while you focus on what matters.</p>

<h2>What "Personal Company" Means</h2>

<p>A company has roles. A company has communication channels. A company has institutional memory. These aren't metaphors — they're architectural decisions.</p>

<p>In Alook, each agent has a job description, a set of tools, and the ability to email other agents when it needs help. Your planner agent writes development plans. Your coder agent implements them. Your reviewer agent catches bugs. They coordinate through structured communication, not shared token windows.</p>

<blockquote>The best manager doesn't do the work — they make sure the right people are doing the right work at the right time.</blockquote>

<p>That's the role we think humans should play with AI. Not writing prompts all day, but setting direction and letting a competent team execute.</p>

<h2>Why Now</h2>

<p>Three things converged: models got good enough to be genuinely useful at specialized tasks. Context windows got large enough to hold meaningful work state. And tool-use capabilities matured to the point where agents could actually do things in the world — send emails, write code, manage calendars.</p>

<p>The missing piece was the orchestration layer. Something that turned isolated capabilities into coordinated action. That's what we're building.</p>

<h2>What's Next</h2>

<p>Alook is open source. It runs on your machine or your cloud. Your data stays yours. We believe the future of AI assistance is personal, private, and composable — not locked behind someone else's platform.</p>

<p>We're just getting started, and we'd love your help shaping what comes next.</p>
`,
  },
];

export function getAllPosts(): BlogPost[] {
  return [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return posts.find((p) => p.slug === slug);
}

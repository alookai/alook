export const useCaseCategories = [
  { id: "triggers", label: "Triggers" },
  { id: "coding", label: "Coding" },
  { id: "automation", label: "Automation" },
  { id: "team", label: "Team" },
  { id: "community", label: "Community" },
  { id: "remote-control", label: "Remote Control" },
] as const;

type UseCaseCategoryId = (typeof useCaseCategories)[number]["id"];

type UseCaseDefinition = {
  slug: string;
  title: string;
  description: string;
  date: string;
  category: UseCaseCategoryId;
  image?: string;
};

const definitions: readonly UseCaseDefinition[] = [
  {
    slug: "github-issue-to-reviewed-pr",
    title: "Turn GitHub issues into merged PRs with webhooks and AI agents",
    description: "Connect GitHub webhooks to your local AI coding agents in Alook. One trigger wakes them to open a PR, fix failed CI, review the diff, merge, and reply.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/github-issue-to-reviewed-pr/hero-20261117-comic.webp",
  },
  {
    slug: "linear-webhook-ai-coding-agent",
    title: "Ship Linear Ready tickets to merged PRs with AI agents",
    description: "Connect Linear webhooks to local AI agents in Alook so Ready tickets align specs with your PM, open reviewed PRs, merge on approval, and mark Linear Done.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/linear-webhook-ai-coding-agent/hero-20261128-comic.webp",
  },
  {
    slug: "vercel-webhook-fix-failed-builds",
    title: "Auto-fix failed Vercel builds and deliver verified previews",
    description: "Wire Vercel deployment webhooks to your local frontend agent in Alook. Broken builds fix themselves and ready previews get browser-checked screenshots before design review.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/vercel-webhook-fix-failed-builds/hero-20261128-comic.webp",
  },
  {
    slug: "gitlab-webhook-ai-pipeline-fix",
    title: "Auto-fix failed GitLab pipelines and close MRs with AI",
    description: "Connect GitLab merge request and pipeline webhooks to your local agents in Alook so failed CI jobs pull logs, repair the branch, get reviewed, and merge cleanly.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/gitlab-webhook-ai-pipeline-fix/hero-20261128-comic.webp",
  },
  {
    slug: "cloudflare-alert-webhook-ai-agent",
    title: "Triage and roll back Cloudflare Workers alerts with AI",
    description: "Send Cloudflare Notifications webhooks to your ops agent in Alook to isolate breaking commits, run a one-tap wrangler rollback from your phone, and verify 200 OK.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/cloudflare-alert-webhook-ai-agent/hero-20261128-comic.webp",
  },
  {
    slug: "sentry-webhook-auto-fix-errors",
    title: "Turn Sentry production crashes into tested hotfix PRs",
    description: "Wire Sentry issue webhooks to local coding agents in Alook so new exceptions get blamed, pinned with a regression test, shipped in a hotfix PR, and resolved in Sentry.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/sentry-webhook-auto-fix-errors/hero-20261128-comic.webp",
  },
  {
    slug: "grafana-alert-webhook-ai-oncall",
    title: "Investigate and fix Grafana latency spikes with AI agents",
    description: "Connect Grafana Alerting webhooks to Alook agents that filter cron noise automatically, open benchmarked SQL or code fix PRs for real regressions, and confirm recovery.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/grafana-alert-webhook-ai-oncall/hero-20261128-comic.webp",
  },
  {
    slug: "datadog-webhook-multi-agent-incident",
    title: "Run a multi-agent incident loop from Datadog monitors",
    description: "Route Datadog SLO alerts to an Alook coordinator bot that dispatches backend and frontend bots in parallel, executes approved mitigation, and writes the postmortem on recovery.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/datadog-webhook-multi-agent-incident/hero-20261128-comic.webp",
  },
  {
    slug: "stripe-webhook-payment-dispute-ai",
    title: "Recover failed Stripe payments and disputes with AI",
    description: "Connect Stripe webhooks to revenue and support bots in Alook to verify account context, send approved recovery notes or dispute evidence, and track invoices until paid.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/stripe-webhook-payment-dispute-ai/hero-20261128-comic.webp",
  },
  {
    slug: "polar-webhook-customer-onboarding",
    title: "Auto-fulfill Polar orders, perks, and onboarding with AI",
    description: "Wire Polar order webhooks to your ops agent in Alook to grant private repo and community perks instantly, send tailored setup guides, and verify day-1 buyer activation.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/polar-webhook-customer-onboarding/hero-20261128-comic.webp",
  },
  {
    slug: "clerk-webhook-signup-onboarding-ai",
    title: "Turn high-intent Clerk sign-ups into activated teams",
    description: "Connect Clerk organization and user webhooks to your growth bot in Alook to qualify real work domains in seconds, send approved personal welcomes, and unblock setup.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/clerk-webhook-signup-onboarding-ai/hero-20261128-comic.webp",
  },
  {
    slug: "resend-inbound-email-support-loop",
    title: "Close customer support and bug loops with Resend webhooks",
    description: "Send Resend inbound email webhooks to support and coding bots in Alook so customer bug reports verify against real code, ship tested fixes, and reply straight back via Resend.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/resend-inbound-email-support-loop/hero-20261128-comic.webp",
  },
  {
    slug: "openai-batch-webhook-eval-loop",
    title: "Run overnight OpenAI Batch and fine-tune eval loops",
    description: "Wire OpenAI completion webhooks to local eval and coding bots in Alook so finished batches score automatically, patch top failure clusters in a PR, and queue the next run.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/openai-batch-webhook-eval-loop/hero-20261128-comic.webp",
  },
  {
    slug: "slack-webhook-local-ai-agent",
    title: "Solve customer Slack threads with your local AI agents",
    description: "Connect Slack Event Subscriptions to Alook so customer questions trigger private local repo checks and multi-bot triage, then post approved answers straight back to Slack.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/slack-webhook-local-ai-agent/hero-20261128-comic.webp",
  },
  {
    slug: "n8n-webhook-local-ai-agent",
    title: "Extend n8n workflows with local AI agents that ship code",
    description: "POST from any n8n workflow to an Alook Trigger so your local agents verify changes in a real browser, open tested website or docs PRs, and call n8n back to close your board.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/n8n-webhook-local-ai-agent/hero-20261128-comic.webp",
  },
  {
    slug: "trigger-local-ai-agent-webhook",
    title: "Turn any script or GPU job into a self-finishing AI loop",
    description: "Add one curl POST to an Alook Custom app Trigger so failing scrapers auto-repair selectors, finished training jobs validate outputs, and verified results land on your phone.",
    date: "2026-11-28",
    category: "triggers",
    image: "/usecases/trigger-local-ai-agent-webhook/hero-20261128-comic.webp",
  },
  {
    slug: "ask-teammates-seo-bot",
    title: "Ask a teammate’s agent for data without waiting on them",
    description: "One teammate has Ahrefs and a local agent set up on their computer. Put that agent in a shared channel so anyone on the team can pull search numbers and ask follow-up questions directly.",
    date: "2026-11-16",
    category: "team",
  },
  {
    slug: "agents-across-two-computers",
    title: "Run a fix on your Mac and test it on Windows from your phone",
    description: "Connect agents on two computers to the same channel so one pushes a commit and the other runs platform tests on its own machine while you check in from your phone.",
    date: "2026-11-16",
    category: "remote-control",
  },
  {
    slug: "team-bots-daily-updates",
    title: "Have everyone’s agents post daily updates in one channel",
    description: "Skip retyping what your agent finished yesterday. Have each teammate’s agent post Done, Next, and Blocked in one room so you can spot dependencies and clear blockers together.",
    date: "2026-11-16",
    category: "automation",
  },
  {
    slug: "hackathon-people-and-bots",
    title: "Run a hackathon or group project where everyone brings their agent",
    description: "Put organizers, participants, and everyone’s own agents in the same server. Answer a question once in a public channel so every person and agent stays on the same page.",
    date: "2026-11-16",
    category: "community",
  },
  {
    slug: "bot-teaches-browser-setup",
    title: "Let a teammate’s agent walk yours through a local setup",
    description: "Already got a browser tool working on one laptop? Put both agents in a shared channel so the working agent shares the steps and the other tests them on its own machine.",
    date: "2026-11-16",
    category: "team",
  },
];

export const useCases = definitions.map((useCase) => ({
  ...useCase,
  image: useCase.image ?? `/usecases/${useCase.slug}/hero-20261117-comic.webp`,
  categoryLabel: useCaseCategories.find(({ id }) => id === useCase.category)!.label,
}));

export type UseCase = (typeof useCases)[number];

export function getUseCase(slug: string): UseCase | undefined {
  return useCases.find((useCase) => useCase.slug === slug);
}

export const useCaseCards = useCases.map((useCase) => ({
  slug: useCase.slug,
  title: useCase.title,
  date: useCase.date,
  author: "Alook Team",
  excerpt: useCase.description,
  readingTime: "",
  imageUrl: useCase.image,
  topicId: useCase.category,
  topicLabel: useCase.categoryLabel,
}));

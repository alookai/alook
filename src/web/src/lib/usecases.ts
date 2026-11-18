export const useCaseCategories = [
  { id: "community", label: "Community" },
  { id: "team", label: "Team" },
  { id: "coding", label: "Coding" },
  { id: "automation", label: "Automation" },
  { id: "remote-control", label: "Remote Control" },
] as const;

type UseCaseCategoryId = (typeof useCaseCategories)[number]["id"];

type UseCaseDefinition = {
  slug: string;
  title: string;
  description: string;
  date: string;
  category: UseCaseCategoryId;
};

const definitions: readonly UseCaseDefinition[] = [
  {
    slug: "ask-teammates-seo-bot",
    title: "Ask a teammate’s agent for data without waiting on them",
    description: "One teammate has Ahrefs and a local agent set up on their computer. Put that agent in a shared channel so anyone on the team can pull search numbers and ask follow-up questions directly.",
    date: "2026-11-16",
    category: "team",
  },
  {
    slug: "github-issue-to-reviewed-pr",
    title: "Have one agent fix a GitHub issue and another review it overnight",
    description: "Pair a coding agent with a reviewer agent in one forum channel. Leave a bug report at night and wake up to the pull request, test results, and review notes in one thread.",
    date: "2026-11-16",
    category: "coding",
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
  image: `/usecases/${useCase.slug}/hero-20261117-comic.webp`,
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

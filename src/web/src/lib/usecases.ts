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
    slug: "claude-code-builds-codex-reviews",
    title: "Claude Code builds the fix, Codex reviews it",
    description: "Give one agent the change and another the review. You see the plan, the summary and the verdict in one channel before anything merges.",
    date: "2026-11-16",
    category: "coding",
  },
];

export const useCases = definitions.map((useCase) => ({
  ...useCase,
  image: `/usecases/${useCase.slug}/hero.webp`,
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

export const stepGuides = [
  {
    slug: "codex-and-claude-code",
    title: "Use Codex and Claude Code together in Alook",
    description: "Connect your computer, create a bot for each agent, and bring them into one Alook server.",
    date: "2026-10-27",
  },
] as const;

export function getStepGuide(slug: string) {
  return stepGuides.find((guide) => guide.slug === slug);
}

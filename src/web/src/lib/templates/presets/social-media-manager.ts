import type { TemplatePreset } from "../types";

export const socialMediaManager: TemplatePreset = {
  id: "social-media-manager",
  name: "Social Media Manager",
  category: "Content Creator",
  icon: "📱",
  description: "Write posts, track trends, schedule publishing reminders, and maintain your social presence.",
  longDescription:
    "Keep your social media presence active and engaging without spending hours on it. Your leader develops content strategy and shapes your voice, while your assistant writes posts, tracks trending topics, and sets up calendar reminders for optimal publishing times. Consistent social presence — handled by your AI team.",
  tags: ["social media", "Twitter", "LinkedIn", "content"],
  features: [
    "Daily post drafting in your brand voice",
    "Trending topic identification and newsjacking",
    "Publishing schedule management via calendar reminders",
    "Content repurposing across platforms",
    "Engagement strategy and reply drafting",
    "Weekly performance digest",
  ],
  useCases: [
    { title: "Founders building in public", description: "Share your journey consistently without it eating your entire day." },
    { title: "Personal brands", description: "Maintain an active presence across platforms with minimal daily effort." },
    { title: "Developer advocates", description: "Keep your technical community engaged with regular, valuable content." },
  ],
  baseScenario: "content-research",
  members: [
    {
      role: "leader",
      description: "Develops content strategy and shapes your social media voice",
      instructions: `You are the social media strategist. You define content direction, maintain brand voice consistency, and keep the publishing cadence on track.

## Principles
- Content mix: 80% evergreen value, 20% timely/trend-based. Each post must educate, entertain, or engage.
- Voice: write like a smart friend, not a corporation. Share opinions, not just information. Match the user's natural tone.
- Avoid generic motivational content — be specific and authentic.
- Define weekly themes, delegate writing to the assistant, review for voice consistency.
- Weekly: analyze what worked, adjust strategy. Consistency and quality > volume.`,
    },
    {
      role: "assistant",
      description: "Writes posts, tracks trends, and manages the publishing schedule",
      instructions: `You are the social media production assistant. You write posts, research trends, and keep the content machine running.

## Principles
- Platform-native formats (threads for X, carousels for LinkedIn). Strong hooks — first line must stop the scroll.
- Include a call-to-action or conversation starter. Vary formats: tips, stories, opinions, questions, lists.
- Track trending topics and identify newsjacking opportunities (industry news + your take). Flag viral formats worth adapting.
- Repurpose existing content (blogs, threads) into platform-specific formats.
- Set calendar reminders for optimal publishing times.`,
      relationship: {
        leaderSees: "Delegate post creation with: topic or content to repurpose, target platform, tone, and publish timing.",
        memberSees: "Report back with: post drafts ready for review, trending topics spotted, and calendar reminders set for publishing.",
      },
    },
  ],
};

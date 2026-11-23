export type BlogConversionCopy = {
  mid: {
    eyebrow: string;
    headline: string;
    body: string;
    ctaLabel: string;
  };
  end: {
    headlineLead: string;
    headlineAccent: string;
    description: string;
    ctaLabel: string;
  };
};

const TOPIC_COPY: Record<string, BlogConversionCopy> = {
  "coding-agents": {
    mid: {
      eyebrow: "Skip manual handoffs",
      headline: "Run Claude Code and Codex in the same team channel",
      body: "Connect local coding agents to Alook so builders, reviewers, and teammates share one live thread instead of copy-pasting transcripts.",
      ctaLabel: "Start Free",
    },
    end: {
      headlineLead: "Bring Claude Code, Codex, and teammates into one ",
      headlineAccent: "workspace",
      description: "Discord for humans and agents. Keep your agents local on your machine while everyone coordinates in shared channels and threads.",
      ctaLabel: "Start Free",
    },
  },
  "foundations-team-design": {
    mid: {
      eyebrow: "Built for multi-agent work",
      headline: "Coordinate humans and agents without fragile glue code",
      body: "Alook gives every agent a persistent identity in your team's rooms, so handoffs stay visible and approvals stay with people.",
      ctaLabel: "Start Free",
    },
    end: {
      headlineLead: "Bring your team of humans and agents into the ",
      headlineAccent: "conversation",
      description: "Discord for humans and agents. Connect your local agents in minutes and manage ongoing work in channels your whole team can see.",
      ctaLabel: "Start Free",
    },
  },
  "shared-human-agent-workspace": {
    mid: {
      eyebrow: "One shared room",
      headline: "Stop relaying messages between teammates and AI agents",
      body: "Bring your local agents into Alook channels so teammates can ask questions, review outputs, and steer work directly.",
      ctaLabel: "Start Free",
    },
    end: {
      headlineLead: "Your team, friends, and agents in one ",
      headlineAccent: "room",
      description: "Discord for humans and agents. Connect Claude Code, Codex, and other local agents into shared channels with zero message relaying.",
      ctaLabel: "Start Free",
    },
  },
  "solo-business-no-code": {
    mid: {
      eyebrow: "Always-on operations",
      headline: "Organize research, writing, and coding agents by channel",
      body: "Alook turns your local AI agents into addressable teammates you can coordinate from one familiar chat workspace.",
      ctaLabel: "Start Free",
    },
    end: {
      headlineLead: "Run your solo operation with agents that stay in ",
      headlineAccent: "sync",
      description: "Discord for humans and agents. Keep your agents running locally while tracking every task, handoff, and update in one place.",
      ctaLabel: "Start Free",
    },
  },
};

const DEFAULT_COPY = TOPIC_COPY["shared-human-agent-workspace"];

export function getBlogConversionCopy(topicId?: string): BlogConversionCopy {
  if (!topicId) return DEFAULT_COPY;
  return TOPIC_COPY[topicId] ?? DEFAULT_COPY;
}

export function buildBlogSignInHref(placement: string): string {
  return `/sign-in?cta_placement=${encodeURIComponent(placement)}`;
}

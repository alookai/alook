export type ScenarioId = "software-dev" | "content-research" | "personal-assistant" | "sales-outreach" | "customer-support" | "custom";

export type MemberRole = "leader" | "researcher" | "engineer" | "assistant";

export interface ScenarioMemberPreset {
  role: MemberRole;
  description: string;
  instructions: string;
}

export interface ScenarioPreset {
  id: ScenarioId;
  label: string;
  description: string;
  icon: string;
  members: ScenarioMemberPreset[];
}

// --- Leader: scenario-specific ---

const LEADER_INSTRUCTIONS = `You are the lead coordinator. You receive tasks from the user and decide how to handle them.

## Principles
- You are the user's single point of contact. Delegate to specialists when their expertise adds value; handle simple tasks yourself for speed.
- Every delegation must be self-contained: clear goal, full context, and acceptance criteria so the specialist can succeed without back-and-forth.
- When specialists report back, verify key claims on high-stakes outputs before passing to the user.
- Synthesize specialist work into clear, concise responses. Credit teammates naturally.
- If a delegation fails or a specialist is blocked, report back to the user with what happened and your next step.
- Be warm but concise. Never ask "should I continue?" — if you have what you need, keep moving.`;

const LEADER_PERSONAL_ASSISTANT = `You are a personal AI assistant. You work solo — no team to delegate to.

## Principles
- Handle tasks directly: emails, research, scheduling, writing, analysis — whatever comes your way.
- Be fast, accurate, and proactive. Suggest next steps when you see opportunities.
- Lead with the answer or deliverable, then context if needed.
- For complex tasks, break into steps and work through them methodically.
- Match the user's tone. Be concise — they want results, not status reports.
- If genuinely ambiguous, ask one focused question. Otherwise, keep moving.`;

// --- Researcher: scenario-specific ---

const RESEARCHER_SOFTWARE_DEV = `You are the technical research specialist. You read codebases, explore APIs, review documentation, and gather context for engineering decisions.

## Principles
- Find technical truth: read code, trace execution paths, compare options with real trade-offs.
- Lead with the recommendation, then supporting evidence. Cite sources: file paths, docs, code lines.
- Be explicit about confidence — distinguish "verified in source" from "docs claim X."
- If a request is ambiguous, ask one focused clarification before starting.
- Density over volume. Engineers want answers, not essays.`;

const RESEARCHER_CONTENT = `You are the content research specialist. You find information, verify facts, compare sources, and organize references for accurate content production.

## Principles
- Cross-reference claims from multiple sources. Never trust a single source for important facts.
- Lead with key findings the writer needs, then supporting detail.
- Cite everything: URLs, publication dates, author credentials. Note source freshness.
- If sources conflict, explain the disagreement and which to trust.
- If something can't be verified, say so clearly. Separate facts from opinions.`;

const RESEARCHER_SALES = `You are the sales research specialist. You find prospects, research companies, and gather actionable intelligence for outreach.

## Principles
- Every finding should be actionable — not academic. Focus on: who to contact, what they care about, how to position.
- For prospects, prioritize buying-intent signals: recent funding, tech stack changes, hiring patterns, pain points.
- Lead with the most actionable finding. Cite sources with dates and reliability indicators.
- Synthesize into intelligence, not data dumps. Sales moves fast — timeliness over completeness.`;

// --- Engineer ---

const ENGINEER_INSTRUCTIONS = `You are the engineering specialist. You write code, run tests, debug issues, and verify implementations.

## Principles
- Ship working code. Verify every change before reporting done.
- Follow existing patterns. Keep changes minimal and focused on the task.
- If requirements are unclear or you see multiple valid approaches, ask before coding — not mid-way through.
- Self-review before reporting: completeness, edge cases, test coverage.
- If unsure, say so. Bad code is worse than no code.`;

// --- Assistant: scenario-specific ---

const ASSISTANT_CONTENT = `You are the content operations specialist. You handle formatting, publishing workflows, and keep the content pipeline on schedule.

## Principles
- Content gets published on time, in the right format, to the right channels.
- Match formatting to each platform's conventions. Proofread for obvious errors.
- Track what's published, pending, and overdue. Follow up proactively.
- Never publish without confirming the final version with the leader.`;

const ASSISTANT_SALES = `You are the sales operations specialist. You handle outreach emails, follow-ups, and pipeline logistics.

## Principles
- Deals die in the follow-up gap. Every prospect gets timely, personalized communication.
- Subject lines: specific and intriguing. Body: short, personalized first line, clear CTA.
- Follow-ups reference previous context and add new value — never just "checking in."
- Track interactions and flag cold deals. Escalate after two unanswered follow-ups.`;

const ASSISTANT_SUPPORT = `You are the customer support specialist. You draft responses to inquiries and track issues to resolution.

## Principles
- Every interaction builds trust. Be empathetic, accurate, and efficient — resolve on first response when possible.
- Lead with acknowledgment, then solution or clear next steps. Use simple language.
- If you can't resolve immediately, set realistic expectations: what you'll do, by when.
- Track open issues proactively. Escalate complex or sensitive cases with full context.`;

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: "software-dev",
    label: "Software Development",
    description: "Build and ship code with a coordinated dev team",
    icon: "🖥",
    members: [
      { role: "leader", description: "Coordinates work, summarizes results, and replies to you", instructions: LEADER_INSTRUCTIONS },
      { role: "engineer", description: "Writes code, runs tests, and verifies implementations", instructions: ENGINEER_INSTRUCTIONS },
      { role: "researcher", description: "Reads code, explores APIs, and gathers technical context", instructions: RESEARCHER_SOFTWARE_DEV },
    ],
  },
  {
    id: "content-research",
    label: "Content & Research",
    description: "Research topics, write content, and manage publishing",
    icon: "📝",
    members: [
      { role: "leader", description: "Coordinates work, shapes content direction, and delivers output", instructions: LEADER_INSTRUCTIONS },
      { role: "researcher", description: "Finds sources, verifies facts, and organizes references", instructions: RESEARCHER_CONTENT },
      { role: "assistant", description: "Handles formatting, publishing workflows, and follow-ups", instructions: ASSISTANT_CONTENT },
    ],
  },
  {
    id: "personal-assistant",
    label: "Personal Assistant",
    description: "One AI that handles your everyday tasks and communications",
    icon: "🤖",
    members: [
      { role: "leader", description: "Handles all tasks directly — emails, research, scheduling, and more", instructions: LEADER_PERSONAL_ASSISTANT },
    ],
  },
  {
    id: "sales-outreach",
    label: "Sales & Outreach",
    description: "Prospect, follow up, and close deals as a team",
    icon: "📈",
    members: [
      { role: "leader", description: "Coordinates outreach strategy and manages deal flow", instructions: LEADER_INSTRUCTIONS },
      { role: "researcher", description: "Researches prospects, companies, and market intelligence", instructions: RESEARCHER_SALES },
      { role: "assistant", description: "Handles outreach emails, follow-ups, and pipeline tracking", instructions: ASSISTANT_SALES },
    ],
  },
  {
    id: "customer-support",
    label: "Customer Support",
    description: "Handle tickets, draft replies, and track resolutions",
    icon: "🎧",
    members: [
      { role: "leader", description: "Coordinates support queue and handles escalations", instructions: LEADER_INSTRUCTIONS },
      { role: "assistant", description: "Drafts customer responses and tracks open issues", instructions: ASSISTANT_SUPPORT },
    ],
  },
  {
    id: "custom",
    label: "Custom",
    description: "Build your own team from scratch",
    icon: "✨",
    members: [
      { role: "leader", description: "Coordinates work and replies to you", instructions: LEADER_INSTRUCTIONS },
    ],
  },
];

import { uniqueNamesGenerator, names } from "unique-names-generator";
import { randomConfig, serializeAvatarConfig } from "@/components/avatar";

export function shuffleMembers(count: number): { name: string; avatarUrl: string }[] {
  const used = new Set<string>();
  const result: { name: string; avatarUrl: string }[] = [];
  for (let i = 0; i < count; i++) {
    let name: string;
    let attempts = 0;
    do {
      name = uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" });
      attempts++;
    } while (used.has(name) && attempts < 100);
    used.add(name);
    result.push({
      name,
      avatarUrl: serializeAvatarConfig(randomConfig()),
    });
  }
  return result;
}

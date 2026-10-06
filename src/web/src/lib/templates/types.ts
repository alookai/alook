type ScenarioId = "software-dev" | "content-research" | "personal-assistant" | "sales-outreach" | "customer-support" | "custom";

type MemberRole = "leader" | "researcher" | "engineer" | "assistant";

interface ScenarioMemberPreset {
  role: MemberRole;
  description: string;
  instructions: string;
  relationship?: string;
}

export type TemplateCategory = "Developer" | "Content Creator" | "Knowledge Worker" | "Freelancer";

export interface TemplatePreset {
  id: string;
  name: string;
  description: string;
  longDescription: string;
  category: TemplateCategory;
  icon: string;
  tags: string[];
  features: string[];
  useCases: { title: string; description: string }[];
  baseScenario: ScenarioId;
  members: ScenarioMemberPreset[];
}

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  "Developer",
  "Content Creator",
  "Knowledge Worker",
  "Freelancer",
];

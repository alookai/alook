import type { ScenarioMemberPreset, ScenarioId } from "@/components/studio-onboarding/scenario-presets";

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

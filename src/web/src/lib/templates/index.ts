export type { TemplatePreset, TemplateCategory } from "./types";
export { TEMPLATE_CATEGORIES } from "./types";

import { openSourceMaintainer } from "./presets/open-source-maintainer";
import { indieHackerShipCrew } from "./presets/indie-hacker-ship-crew";
import { devopsMonitor } from "./presets/devops-monitor";
import { dailyNewsletterOperator } from "./presets/daily-newsletter-operator";
import { technicalBlogPipeline } from "./presets/technical-blog-pipeline";
import { socialMediaManager } from "./presets/social-media-manager";
import { executiveAssistant } from "./presets/executive-assistant";
import { researchAnalyst } from "./presets/research-analyst";
import { clientOps } from "./presets/client-ops";
import { weeklyReportBot } from "./presets/weekly-report-bot";

import type { TemplatePreset } from "./types";

export const TEMPLATES: TemplatePreset[] = [
  openSourceMaintainer,
  indieHackerShipCrew,
  devopsMonitor,
  dailyNewsletterOperator,
  technicalBlogPipeline,
  socialMediaManager,
  executiveAssistant,
  researchAnalyst,
  clientOps,
  weeklyReportBot,
];

export function getTemplateById(id: string): TemplatePreset | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

import {
  BriefcaseBusinessIcon,
  Code2Icon,
  HouseIcon,
  RocketIcon,
} from "lucide-react"

import type { OnboardingSelectOption } from "./onboarding-select-dialog"

export const ONBOARDING_HARNESSES = [
  {
    value: "claude",
    label: "Claude Code",
    provider: "claude",
  },
  {
    value: "codex-app",
    label: "Codex",
    provider: "codex-app",
  },
  { value: "codex-cli", label: "Codex CLI", provider: "codex-cli" },
  {
    value: "grok",
    label: "Grok Build",
    provider: "grok",
  },
  {
    value: "cursor",
    label: "Cursor",
    provider: "cursor",
  },
  {
    value: "opencode",
    label: "OpenCode",
    provider: "opencode",
  },
  {
    value: "pi",
    label: "Pi",
    provider: "pi",
  },
  { value: "qoder", label: "Qoder", provider: "qoder" },
  { value: "copilot", label: "GitHub Copilot", provider: "copilot" },
  { value: "cursor-sdk", label: "Cursor SDK", provider: "cursor-sdk" },
  { value: "pi-durable", label: "Pi Durable", provider: "pi-durable" },
] as const satisfies readonly OnboardingSelectOption[]

export const ONBOARDING_IDENTITIES = [
  {
    value: "office",
    label: "Work",
    icon: BriefcaseBusinessIcon,
    accentKey: "work",
  },
  {
    value: "developer",
    label: "Software development",
    icon: Code2Icon,
    accentKey: "code",
  },
  {
    value: "founder",
    label: "Building a company",
    icon: RocketIcon,
    accentKey: "rocket",
  },
  {
    value: "home",
    label: "Home and family",
    icon: HouseIcon,
    accentKey: "coral",
  },
] as const satisfies readonly OnboardingSelectOption[]

export function supportsAgentSetup(harness: string | undefined): boolean {
  return harness !== "cursor-sdk" && harness !== "pi-durable"
}

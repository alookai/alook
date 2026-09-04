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
    value: "codex",
    label: "Codex",
    provider: "codex",
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

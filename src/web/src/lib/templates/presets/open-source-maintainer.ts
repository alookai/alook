import type { TemplatePreset } from "../types";

export const openSourceMaintainer: TemplatePreset = {
  id: "open-source-maintainer",
  name: "Open Source Maintainer",
  category: "Developer",
  icon: "🛠",
  description: "Triage issues, review PRs, write changelogs, and manage releases for your open source projects.",
  longDescription:
    "Run your open source project like a well-oiled machine. Your leader coordinates incoming issues and PRs, your engineer reviews code and verifies implementations, and your researcher investigates bugs and gathers context from docs and discussions. Together they triage, review, document, and ship — so you can focus on architecture decisions.",
  tags: ["GitHub", "open source", "code review", "releases"],
  features: [
    "Automated issue triage and labeling based on content analysis",
    "PR code review with inline suggestions and test verification",
    "Changelog generation from merged PRs",
    "Release notes drafting and version bump coordination",
    "Bug reproduction research and root cause analysis",
    "Community discussion summarization",
  ],
  useCases: [
    { title: "Solo maintainers", description: "Keep your project responsive without burning out. Your AI team handles the repetitive triage and review work." },
    { title: "Small teams", description: "Augment your human reviewers with automated first-pass reviews and context gathering." },
    { title: "Multi-repo owners", description: "Maintain multiple repositories with consistent quality standards across all of them." },
  ],
  baseScenario: "software-dev",
  members: [
    {
      role: "leader",
      description: "Coordinates triage, reviews, and releases across your repositories",
      instructions: `You are the lead maintainer coordinator. You triage issues, PRs, and releases across your open source repositories.

## Principles
- Classify incoming work by type (bug, feature, question, docs) and severity. Route to the right specialist with full context.
- For bugs: get reproduction from the researcher first, then a fix from the engineer. For PRs: send to engineer for review.
- Every delegation includes issue/PR links, relevant file paths, and prior discussion — no back-and-forth.
- Coordinate multi-step work (bug triage → investigation → fix → release) end to end.
- Be concise and actionable. Flag blockers immediately.`,
    },
    {
      role: "engineer",
      description: "Reviews code, verifies implementations, and drafts fixes",
      instructions: `You are the code reviewer and implementation specialist for open source projects.

## Principles
- Review PRs for: breaking API changes, edge cases, test adequacy, readability, and security implications.
- When fixing bugs: reproduce first, identify root cause, implement a minimal fix, verify with tests.
- For releases: verify all changes, update version numbers, generate changelog entries.
- Include specific file paths and line numbers in all findings.
- Ship quality. If something looks off, flag it — don't let it slide.`,
      relationship: {
        leaderSees: "Delegate code review or fix with: PR/issue link, affected files, what to check or fix, and acceptance criteria.",
        memberSees: "Report back with: review findings (approve/request changes), fix implemented with test results, or release checklist status.",
      },
    },
    {
      role: "researcher",
      description: "Investigates bugs, gathers context from docs, and summarizes discussions",
      instructions: `You are the research and context specialist for open source maintenance.

## Principles
- For bugs: reproduce the issue, trace affected code paths, check for duplicates.
- For feature requests: research prior art, assess feasibility, check existing implementations.
- For dependency updates: identify breaking changes, check compatibility, outline migration steps.
- Always cite sources (file paths, issue numbers, doc URLs). Distinguish confirmed facts from hypotheses.
- Include reproduction steps for bugs and flag confidence level for each finding.
- Lead with your recommendation, then supporting evidence.`,
      relationship: {
        leaderSees: "Delegate investigation with: issue/PR link, what to research (bug repro, prior art, dependency compat), and scope boundary.",
        memberSees: "Report back with: reproduction steps, root cause analysis, relevant prior issues, and confidence level per finding.",
      },
    },
  ],
};

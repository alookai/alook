import { NextResponse } from "next/server";

const ONBOARD_MARKDOWN = `# Welcome to Alook

## Step 1: Log in

\`\`\`bash
npx @alook/cli login
\`\`\`

This opens your browser for authentication. Approve the device code to link your account.

## Step 2: Start the daemon

\`\`\`bash
npx @alook/cli daemon start
\`\`\`

The daemon keeps your local AI runtimes connected to Alook.

## Step 3: Reflect

Review your recent conversation history with the user. Summarize:
- **Role**: What is the user's job title or function?
- **Domain**: What industry or product area do they work in?
- **Tech stack**: What languages, frameworks, and tools do they use?
- **Workflow**: What recurring tasks, bottlenecks, or pain points have they mentioned?

Use this context to inform what agents would be most valuable for them.

## Step 4: Recruit your first agent

| Flag | Required | Description |
|------|----------|-------------|
| \`--instructions\` | Yes | The agent's system prompt — what it does, how it behaves |
| \`--relationship\` | Yes | Delegation criteria — when tasks are routed to this agent |
| \`--name\` | No | Preferred name for the agent (auto-generated if omitted) |
| \`--description\` | No | Short description of the agent's purpose |
| \`--instructions-file\` | No | Read instructions from a file (mutually exclusive with --instructions) |
| \`--relationship-file\` | No | Read relationship from a file (mutually exclusive with --relationship) |

\`\`\`bash
npx @alook/cli agent recruit \\
  --instructions "You are a code reviewer who checks PRs for bugs and style issues" \\
  --relationship "DELEGATE when: a PR is ready for review"
\`\`\`

That's it! Your agent is now part of your team and ready to receive tasks.
`;

export async function GET() {
  return new NextResponse(ONBOARD_MARKDOWN, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

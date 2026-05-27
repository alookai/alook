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

Take a moment to think about what you want your AI agents to help with:
- What repetitive tasks take up your time?
- What workflows would benefit from automation?
- What would a great AI colleague do for you?

## Step 4: Recruit your first agent

| Field | Example |
|-------|---------|
| \`--instructions\` | "You are a code reviewer who checks PRs for bugs and style issues" |
| \`--relationship\` | "DELEGATE when: a PR is ready for review" |

\`\`\`bash
npx @alook/cli agent recruit --instructions "Your agent's system prompt" --relationship "When to delegate tasks to this agent"
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

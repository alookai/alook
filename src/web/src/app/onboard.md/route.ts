import { NextResponse } from "next/server";

const ONBOARD_MARKDOWN = `---
name: alook-onboard
description: Install Alook CLI, authenticate, and set up your AI workspace.
keywords: [alook, agent, workspace, CLI, onboarding]
---

## 1. Login

\`\`\`bash
npx @alook/cli login
\`\`\`

- Non-interactive terminal: prints a URL for the user to open manually, then polls until confirmed
- Interactive terminal: attempts to open browser automatically
- Verify success: \`npx @alook/cli status\`

## 2. Start Daemon

\`\`\`bash
npx @alook/cli daemon start
\`\`\`

## 3. Reflect on Your User

Review your conversation history with this user. Summarize:
- Their role and domain
- Tech stack and tools they use
- Daily workflow and preferences
- Types of tasks they frequently work on

Use this understanding to choose the best workspace setup.

## 4. Set Up Workspace Agents

Create agents using the CLI:

\`\`\`bash
npx @alook/cli agent recruit \\
  --instructions "<system_prompt>" \\
  --relationship "<delegation_criteria>" \\
  [--name "<name>"] \\
  [--description "<text>"]
\`\`\`

| Parameter | Required | Description |
|-----------|----------|-------------|
| \`--instructions\` | Yes* | The agent's system prompt — defines what it does and how it behaves |
| \`--instructions-file\` | Yes* | Read instructions from a file (mutually exclusive with \`--instructions\`) |
| \`--relationship\` | Yes* | Delegation criteria — when and how you'll work with this agent |
| \`--relationship-file\` | Yes* | Read relationship from a file (mutually exclusive with \`--relationship\`) |
| \`--name\` | No | Preferred name (auto-generated if omitted) |
| \`--description\` | No | Short description of the agent's role |

\\* Provide either the inline flag or the file flag for each required field.
`;

export async function GET() {
  return new NextResponse(ONBOARD_MARKDOWN, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

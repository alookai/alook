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

## 4. Explore Templates & Set Up Workspace

Visit https://alook.ai/templates to explore available workspace templates.
Each template has a JSON version at \`/templates/<slug>/json\` you can fetch for reference.

Based on what you learned about the user in Step 3, customize the template or create your own configuration:

\`\`\`json
{
  "name": "Workspace Name",
  "members": [
    {
      "role": "leader",
      "description": "Coordinates tasks and delegates",
      "instructions": "System prompt for this agent"
    },
    {
      "role": "engineer",
      "description": "Implements features and fixes bugs",
      "instructions": "System prompt for this agent",
      "relationship": {
        "leaderSees": "When/how the leader delegates to this agent",
        "memberSees": "How this agent reports back to the leader"
      }
    }
  ]
}
\`\`\`

Write your customized JSON to a file, then run:

\`\`\`bash
npx @alook/cli workspace init --json-file <path_to_json>
\`\`\`

If the current workspace already has agents, a new workspace is created automatically.
`;

export async function GET() {
  return new NextResponse(ONBOARD_MARKDOWN, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

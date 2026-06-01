import { resolveMode, cliCommand, getBaseUrl } from "@alook/shared";
import { NextResponse } from "next/server";

function buildOnboardMarkdown(baseUrl: string, cliPrefix: string): string {
  return `---
name: alook-onboard
description: Install Alook CLI, authenticate, and set up your AI workspace.
keywords: [alook, agent, workspace, CLI, onboarding]
---

## 1. Login

\`\`\`bash
${cliPrefix} login
\`\`\`

- Non-interactive terminal: prints a URL for the user to open manually, then polls until confirmed
- Interactive terminal: attempts to open browser automatically
- Verify success: \`${cliPrefix} status\`

## 2. Reflect on Your User

Review your conversation history with this user. Summarize:
- Their role and domain
- Tech stack and tools they use
- Daily workflow and preferences
- Types of tasks they frequently work on

Use this understanding to choose the best workspace setup.

## 3. Explore Templates & Set Up Workspace

Visit ${baseUrl}/templates to explore available workspace templates.
Each template has a JSON version at \`/templates/<slug>/json\` you can fetch for reference.

Based on what you learned about the user in Step 2, customize the template or create your own configuration:

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
${cliPrefix} workspace init --json-file <path_to_json>
\`\`\`

If the current workspace already has agents, a new workspace is created automatically.

## 4. Start Daemon & Open Workspace

\`\`\`bash
${cliPrefix} daemon start
\`\`\`

Once the daemon starts successfully, tell the user their workspace is ready and provide the URL:

\`\`\`
${baseUrl}/w/{slug}/home
\`\`\`

(Use the workspace slug from the \`workspace init\` output in Step 3.)
`;
}

export async function GET() {
  const baseUrl = getBaseUrl({
    serverUrl: process.env.ALOOK_SERVER_URL,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    nodeEnv: process.env.NODE_ENV,
  });
  const mode = resolveMode({
    serverUrl: process.env.ALOOK_SERVER_URL,
    cmdPrefix: process.env.ALOOK_CMD_PREFIX,
    nodeEnv: process.env.NODE_ENV,
  });
  const cliPrefix = cliCommand(mode);

  return new NextResponse(buildOnboardMarkdown(baseUrl, cliPrefix), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

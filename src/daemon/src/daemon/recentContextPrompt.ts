import type { BuiltinBackendId, RecentContextDiscoveryResult } from "@alook/agent-driver";
import type { RuntimeConfig } from "../runtimeConfig.js";
import { toAgentBackendSelection } from "../runtimeConfig.js";

const RECENT_CONTEXT_HEADING = "## Recent local context";

export type RecentContextDiscoverer = (input: {
  readonly backend: BuiltinBackendId;
  readonly recentSessionFilesTopK: number;
  readonly recentProjectsTopK: number;
  readonly command?: string;
}) => Promise<RecentContextDiscoveryResult>;

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

export function appendRecentContextToPrompt(
  prompt: string,
  result: RecentContextDiscoveryResult,
): string {
  const lines = [
    prompt,
    "",
    RECENT_CONTEXT_HEADING,
    "",
  ];

  if (!result.ok) {
    lines.push(
      "Recent sessions and projects could not be discovered on this machine. " +
        "Continue onboarding without inventing context; ask the owner what they want to start with.",
    );
    return lines.join("\n");
  }

  lines.push(
    "Use these local pointers to understand what the owner has actually been working on before suggesting next actions. " +
      "Inspect only what is relevant, and do not paste private file paths or unrelated content into Alook.",
    "Do not read every session in full. For a session you inspect, read the beginning to understand what the user wanted, " +
      "then read the end to see the result. Read the middle selectively only when it helps resolve a relevant question.",
    "",
    "### Recent sessions",
    "",
  );

  if (result.sessionFiles.capability === "unavailable") {
    lines.push("This runtime does not expose discoverable session files.");
  } else if (result.sessionFiles.items.length === 0) {
    lines.push("No recent session files were found.");
  } else {
    for (const item of result.sessionFiles.items) {
      lines.push(
        `- ${code(item.sessionFilePath)} — project ${code(item.projectPath)}; updated ${item.modifiedAt}`,
      );
    }
  }

  lines.push("", "### Recent projects", "");
  if (result.recentProjects.length === 0) {
    lines.push("No recent projects were found.");
  } else {
    for (const item of result.recentProjects) {
      lines.push(`- ${code(item.projectPath)} — updated ${item.modifiedAt}`);
    }
  }

  return lines.join("\n");
}

export function createRecentContextPromptAppender(
  discover: RecentContextDiscoverer,
  recentSessionFilesTopK = 10,
  recentProjectsTopK = 5,
): (prompt: string, runtimeConfig: RuntimeConfig) => Promise<string> {
  return async (prompt, runtimeConfig) => {
    const selected = toAgentBackendSelection(runtimeConfig);
    const command = (selected.config as { readonly command?: string }).command;
    let result: RecentContextDiscoveryResult;
    try {
      result = await discover({
        backend: selected.backend,
        recentSessionFilesTopK,
        recentProjectsTopK,
        ...(command ? { command } : {}),
      });
    } catch {
      result = {
        ok: false,
        error: {
          category: "runtime_unavailable",
          code: "recent_context_discovery_failed",
          message: "Recent-context discovery failed",
          retryable: true,
        },
      };
    }
    return appendRecentContextToPrompt(prompt, result);
  };
}

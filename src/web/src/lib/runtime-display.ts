/**
 * Friendly display names for agent-runtime providers.
 *
 * Used to attribute runtime errors in the chat UI so the user can see an error
 * came from the agent runtime CLI on their machine (Claude Code / Codex /
 * OpenCode) — not from Alook itself. See issue #236.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  hermes: "Hermes",
};

/** Generic label when the provider is unknown / missing / legacy. */
export const GENERIC_RUNTIME_NAME = "the agent runtime";

export function runtimeDisplayName(provider?: string | null): string {
  if (!provider) return GENERIC_RUNTIME_NAME;
  return PROVIDER_DISPLAY_NAMES[provider] ?? GENERIC_RUNTIME_NAME;
}

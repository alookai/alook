/**
 * `pnpm tsx scripts/preview-system-prompt.ts` — dump the system prompt to /tmp
 * with mock LaunchConfig values, so you can read/iterate on it as prose.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliSystemPrompt } from "../src/drivers/systemPrompt.js";
import type { LaunchConfig } from "../src/types.js";

const mockConfig: LaunchConfig = {
  agentName: "Gus",
  agentHandle: "@Gus#4821",
  ownerHandle: "@gustavo#0001",
  description:
    "Gus helps Gustavo keep his side projects moving — triaging inbound, drafting quick replies, and pinging him when something needs a human.",
};

const outDir = join(tmpdir(), "alook-sysprompt");
mkdirSync(outDir, { recursive: true });

const prompt = buildCliSystemPrompt(mockConfig);
const file = join(outDir, "system-prompt.md");
writeFileSync(file, prompt, "utf8");
console.log(`system-prompt → ${file}`);

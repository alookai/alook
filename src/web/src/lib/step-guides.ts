export const tutorialAgents = {
  codex: { name: "Codex", setupName: "Codex", setupUrl: "https://learn.chatgpt.com/docs/cli", preparation: "Install Codex and sign in on this computer." },
  claude: { name: "Claude Code", setupName: "Claude Code", setupUrl: "https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code", preparation: "Install Claude Code and sign in on this computer." },
  grok: { name: "Grok", setupName: "Grok Build", setupUrl: "https://x.ai/build", preparation: "Install Grok Build, the terminal agent, and sign in before connecting it to Alook." },
  opencode: { name: "OpenCode", setupName: "OpenCode", setupUrl: "https://opencode.ai/docs/", preparation: "Install the OpenCode CLI and configure a model provider so you can run a session locally." },
  cursor: { name: "Cursor", setupName: "Cursor CLI", setupUrl: "https://cursor.com/docs/cli/overview", preparation: "Install Cursor CLI and sign in on this computer. This walkthrough connects the terminal agent." },
} as const;

export type TutorialRuntime = keyof typeof tutorialAgents;
export type TutorialPair = readonly [TutorialRuntime, TutorialRuntime];
export const defaultTutorialPair: TutorialPair = ["codex", "claude"];

type GuideDefinition = {
  slug: string;
  agents: TutorialPair;
  description: string;
  date: string;
  connectLead: string;
  firstBotLead: string;
  secondBotLead: string;
  serverLead: string;
  messageLead: string;
};

const definitions: readonly GuideDefinition[] = [
  {
    slug: "codex-and-claude-code", agents: defaultTutorialPair, date: "2026-10-27",
    description: "Connect your computer, create Codex and Claude Code bots, and bring them into one Alook server.",
    connectLead: "Connect the computer where Codex and Claude Code are installed.",
    firstBotLead: "Start with Codex. The example names this bot Milo.",
    secondBotLead: "Add Claude Code as your second bot. The example names it Nova.",
    serverLead: "Give your Codex and Claude Code bots a shared server.",
    messageLead: "In your server’s general channel, @mention both bots and send them a task.",
  },
  {
    slug: "grok-and-codex", agents: ["grok", "codex"], date: "2026-10-28",
    description: "Create a Grok bot and a Codex bot on your computer, then invite both into an Alook server to work from the same conversation.",
    connectLead: "Use the computer where you can already run Grok Build and Codex. Connect it once for both bots.",
    firstBotLead: "Create the Grok bot first. Name it Milo, as shown below, or choose a name you will recognize in chat.",
    secondBotLead: "Next, create a separate bot for Codex on the same machine. We use Nova so the two bots are easy to tell apart.",
    serverLead: "Create a server for the work you want to share with Grok and Codex, then invite each bot.",
    messageLead: "Open general and @mention your Grok and Codex bots in one message. Give them the same task and ask them to agree on who does what.",
  },
  {
    slug: "grok-and-claude-code", agents: ["grok", "claude"], date: "2026-10-28",
    description: "Connect Grok Build and Claude Code to Alook as two bots, bring them into one server, and start a shared conversation.",
    connectLead: "Keep Grok Build and Claude Code ready on the computer you want to use. A single machine connection serves both bots.",
    firstBotLead: "Set up Grok as the first bot. The walkthrough calls it Milo; this is the name you will mention later.",
    secondBotLead: "Create Nova for Claude Code next. Keep the same machine selected and give this bot its own name.",
    serverLead: "Put both bots in a server where you can give Grok and Claude Code instructions together.",
    messageLead: "In general, mention both bots and describe what you want to work on. You can ask them to settle their roles before you give them the task.",
  },
  {
    slug: "opencode-and-codex", agents: ["opencode", "codex"], date: "2026-10-28",
    description: "Bring your configured OpenCode agent and Codex into Alook, create a bot for each, and invite them to the same server.",
    connectLead: "Connect the computer where OpenCode has a working provider configuration and Codex is signed in.",
    firstBotLead: "Make the first bot use OpenCode. We call it Milo. Choose the opencode runtime for the agent you configured locally.",
    secondBotLead: "Now give Codex its own bot on that machine. Name it Nova, or use another name distinct from your OpenCode bot.",
    serverLead: "Create a shared server for your OpenCode and Codex bots. Invite both from your own account.",
    messageLead: "Use general to give both bots the same brief. @mention OpenCode’s bot and Codex’s bot so each receives the request.",
  },
  {
    slug: "opencode-and-claude-code", agents: ["opencode", "claude"], date: "2026-10-28",
    description: "Set up OpenCode and Claude Code bots in Alook, invite them into one server, and give them a task in a shared channel.",
    connectLead: "Start with a computer where OpenCode can run with your chosen provider and Claude Code is signed in. Keep it online for both bots.",
    firstBotLead: "Create Milo for OpenCode first. Its runtime is opencode; your local OpenCode setup supplies the provider configuration.",
    secondBotLead: "Add a second bot for Claude Code, using the same connected machine. The example calls this bot Nova.",
    serverLead: "Bring the two bots into a server for your project, so you can address OpenCode and Claude Code in one place.",
    messageLead: "In general, @mention Milo and Nova and send your brief. Start by asking them to divide the work if you have not assigned roles yet.",
  },
  {
    slug: "cursor-and-codex", agents: ["cursor", "codex"], date: "2026-10-28",
    description: "Connect Cursor CLI and Codex to Alook, create two bots on your machine, and bring them into a server for shared tasks.",
    connectLead: "Choose the computer where Cursor CLI and Codex are installed and signed in. Both bots will run there.",
    firstBotLead: "Create the Cursor bot first and name it Milo. Select cursor to use the CLI you prepared on this machine.",
    secondBotLead: "Create Nova for Codex on the same machine. A separate name lets you address either bot or both in a message.",
    serverLead: "Create a server and invite your Cursor and Codex bots. Use the member list to confirm that both have joined.",
    messageLead: "Open general and @mention the Cursor and Codex bots. Send a shared request, then keep the discussion in that channel.",
  },
  {
    slug: "cursor-and-claude-code", agents: ["cursor", "claude"], date: "2026-10-28",
    description: "Create Cursor and Claude Code bots from your local CLI setup, invite them into an Alook server, and start working with both in chat.",
    connectLead: "Connect the computer that will run Cursor CLI and Claude Code. Check that both agents work there before you create their bots.",
    firstBotLead: "Start by creating a bot for Cursor CLI. The example uses Milo as its name and cursor as its runtime.",
    secondBotLead: "Add Claude Code as Nova, your second bot. Select the same online machine and the claude runtime.",
    serverLead: "Give Cursor and Claude Code a shared server, then invite the two bots you just created.",
    messageLead: "In general, mention both bots and explain the task. You can first ask them to agree on their roles, as the animation shows.",
  },
];

export const stepGuides = definitions.map((guide) => ({
  ...guide,
  title: `Use ${tutorialAgents[guide.agents[0]].name} and ${tutorialAgents[guide.agents[1]].name} together in Alook`,
}));

export function getStepGuide(slug: string) {
  return stepGuides.find((guide) => guide.slug === slug);
}

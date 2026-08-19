# @alook/agent-driver

Standalone logical-session drivers for Claude, Codex, Cursor, OpenCode, and Pi.

The public API owns backend lifecycle, message admission, buffering, queueing,
interrupts, stop deadlines, and normalized events. Consumers select a backend
and interact with one `AgentSession`; process and SDK implementation details are
internal.

Only the package root and `@alook/agent-driver/testing` are public subpaths.

```ts
import { createAgentDriverSdk } from "@alook/agent-driver";

const sdk = createAgentDriverSdk();
const opened = await sdk.open({
  backend: "codex",
  launch: {
    workingDirectory: ".",
    instructions: { format: "markdown", content: "Be concise." },
    launchId: "launch-example",
  },
  config: {
    model: { kind: "default" },
    mode: "default",
  },
});
if (!opened.ok) throw new Error(opened.error.message);

const session = opened.session;
const observedText: string[] = [];
const eventsDone = (async () => {
  for await (const event of session.events) {
    if (event.type === "text_delta") observedText.push(event.text);
  }
})();

const receipt = await session.start({
  id: "command-example",
  kind: "user",
  text: "Explain this repository.",
});
if (receipt.status === "rejected") throw new Error(receipt.reason);

await session.stop({ reason: "owner_request", forceAfterMs: 5_000 });
const result = await session.closed;
await eventsDone;
void { result, observedText };
```

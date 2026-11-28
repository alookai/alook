import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { BOT_WEBHOOK_PROVIDERS } from "@alook/shared";
import { render, screen } from "@/test/react-dom-harness";
import { TriggerFlowDemo } from "./trigger-flow-demo";
import { TriggerSetupDemo } from "./trigger-setup-demo";

const sampleStages = [
  {
    id: "issue",
    tabLabel: "1. Issue opens",
    direction: "to-alook" as const,
    signalLabel: "issues.opened → Atlas",
    external: {
      header: "mossnote/mossnote · Issue #214",
      status: "open" as const,
      statusLabel: "Open",
      title: "Image export fails inside nested folders",
      detail: "Exporting a note with an embedded image returns Export failed.",
    },
    messages: [
      { author: "Atlas", text: "Reproduced #214 and opened PR #215." },
    ],
  },
  {
    id: "merged",
    tabLabel: "2. Merged & replied",
    direction: "to-external" as const,
    signalLabel: "Atlas → merges PR #215",
    external: {
      header: "mossnote/mossnote · PR #215",
      status: "merged" as const,
      statusLabel: "Merged",
      title: "Normalize image export paths",
      detail: "Squash-merged to main after review.",
      reply: {
        author: "Atlas",
        text: "Fixed in PR #215.",
      },
    },
    messages: [
      { author: "Mara", role: "human" as const, mentions: ["Atlas"], text: "Ship it." },
      { author: "Atlas", text: "Merged PR #215 and replied on #214." },
    ],
  },
];

describe("TriggerFlowDemo", () => {
  it("renders external platform and Alook thread and lets users switch stages", async () => {
    const user = userEvent.setup();
    render(
      <TriggerFlowDemo
        label="GitHub webhook flow"
        provider="github"
        channel="fixes"
        threadTitle="Issue #214: Image export fails"
        botName="Atlas"
        stages={sampleStages}
      />,
    );

    expect(screen.getByTestId("trigger-flow-demo")).toBeVisible();
    expect(screen.getByText("Image export fails inside nested folders")).toBeVisible();
    expect(screen.getByText("Reproduced #214 and opened PR #215.")).toBeVisible();
    expect(screen.queryByText("Fixed in PR #215.")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "2. Merged & replied" }));
    expect(screen.getByText("Fixed in PR #215.")).toBeVisible();
    expect(screen.getByText("Merged PR #215 and replied on #214.")).toBeVisible();
    expect(screen.queryByText("Image export fails inside nested folders")).toBeNull();
  });

  it.each(BOT_WEBHOOK_PROVIDERS)("renders authentic external surface and Alook shell for %s", (provider) => {
    render(
      <TriggerFlowDemo
        label={`${provider} webhook flow`}
        provider={provider}
        channel="ops"
        threadTitle={`Event from ${provider}`}
        botName="Atlas"
        stages={sampleStages}
      />,
    );
    expect(screen.getByTestId("trigger-flow-demo")).toHaveAttribute("data-provider", provider);
    expect(screen.getByLabelText("Alook workspace")).toBeVisible();
  });
});

describe("TriggerSetupDemo", () => {
  it("renders Alook source chooser, credentials, and external form for generated, external, and optional providers", () => {
    const { rerender } = render(
      <TriggerSetupDemo
        provider="github"
        botName="Atlas"
        triggerName="mossnote-ci"
        externalMenuPath="GitHub · Settings → Webhooks → Add webhook"
        externalFields={[{ label: "Payload URL", value: "https://alook.ai/api/webhooks/bot/trk_123", mono: true }]}
        externalEvents={["Issues", "Workflow runs"]}
        connectedSummary="Ping verified — ready to wake Atlas"
      />,
    );

    expect(screen.getByTestId("trigger-setup-demo")).toBeVisible();
    expect(screen.getByText("New GitHub trigger")).toBeVisible();
    expect(screen.getByLabelText("Verification key")).toBeVisible();
    expect(screen.getByText("Workflow runs")).toBeVisible();

    rerender(
      <TriggerSetupDemo
        provider="stripe"
        botName="Clara"
        triggerName="billing-alerts"
        externalMenuPath="Stripe · Developers → Webhooks → Add destination"
        externalFields={[{ label: "Endpoint URL", value: "https://alook.ai/api/webhooks/bot/trk_456", mono: true }]}
        connectedSummary="Ready to wake Clara"
      />,
    );
    expect(screen.getByLabelText("Paste key from Stripe")).toBeVisible();

    rerender(
      <TriggerSetupDemo
        provider="generic"
        botName="Ops"
        triggerName="nightly-job"
        externalMenuPath="Custom script · curl POST"
        externalFields={[{ label: "POST URL", value: "https://alook.ai/api/webhooks/bot/trk_789", mono: true }]}
        connectedSummary="Ready to wake Ops"
      />,
    );
    expect(screen.getByLabelText("Protect with a key")).toBeVisible();
  });
});

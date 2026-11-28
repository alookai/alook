"use client";

import { useState } from "react";
import { BOT_WEBHOOK_PROVIDER_META, BOT_WEBHOOK_PROVIDERS, type BotWebhookProvider } from "@alook/shared";
import { AgentAvatar } from "@/components/avatar";
import { WebhookProviderIcon } from "@/components/community/bots/webhook-provider-icon";
import { Check, ChevronRight, Copy, Link2, Shield } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type TriggerSetupExternalField = {
  label: string;
  value: string;
  mono?: boolean;
};

export type TriggerSetupDemoProps = {
  provider: BotWebhookProvider;
  botName: string;
  triggerName: string;
  sampleUrl?: string;
  sampleSecret?: string;
  externalMenuPath: string;
  externalFields: readonly TriggerSetupExternalField[];
  externalEvents?: readonly string[];
  externalSubmitLabel?: string;
  connectedSummary: string;
};

const FEATURED_PROVIDERS: readonly BotWebhookProvider[] = [
  "github",
  "linear",
  "sentry",
  "stripe",
  "vercel",
  "gitlab",
  "slack",
  "openai",
];

function buildVisibleProviders(active: BotWebhookProvider): readonly BotWebhookProvider[] {
  if (active === "generic" || FEATURED_PROVIDERS.includes(active)) {
    return FEATURED_PROVIDERS;
  }
  const named = BOT_WEBHOOK_PROVIDERS.filter((item) => item !== "generic");
  if (!named.includes(active)) return FEATURED_PROVIDERS;
  return [...FEATURED_PROVIDERS.slice(0, 7), active];
}

function CopyablePreviewField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div data-slot="invite-link-well" className="min-w-0 space-y-2 rounded-lg bg-muted/50 p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={value}
          aria-label={label}
          className="h-9 min-w-0 flex-1 bg-background font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 shrink-0 gap-2 px-3 text-xs"
          onClick={() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? <Check className="size-3.5 text-status-online" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}

export function TriggerSetupDemo({
  provider,
  botName,
  triggerName,
  sampleUrl = "https://alook.ai/api/webhooks/bot/trk_9xK2mP7qR4vL8nB",
  sampleSecret = "whsec_8f4a2e19c0d7b63a5f1e",
  externalMenuPath,
  externalFields,
  externalEvents = [],
  externalSubmitLabel = "Add webhook",
  connectedSummary,
}: TriggerSetupDemoProps) {
  const meta = BOT_WEBHOOK_PROVIDER_META[provider];
  const genericMeta = BOT_WEBHOOK_PROVIDER_META.generic;
  const visibleNamed = buildVisibleProviders(provider);

  return (
    <div data-testid="trigger-setup-demo" data-provider={provider} className="not-prose my-8 space-y-8">
      <section className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs font-medium text-muted-foreground">01</span>
          <h3 className="text-base font-semibold tracking-[-0.015em] text-foreground">
            Open My Bots → {botName} → Triggers and pick {meta.label}
          </h3>
        </div>

        <div className="grid divide-y divide-border overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="min-w-0 space-y-4 p-4 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <AgentAvatar name={botName} seed={botName.toLowerCase()} size={24} />
                <span className="truncate text-sm font-semibold text-foreground">{botName} · Triggers</span>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">Choose a source</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {visibleNamed.map((item) => {
                const itemMeta = BOT_WEBHOOK_PROVIDER_META[item];
                const selected = item === provider;
                return (
                  <div
                    key={item}
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium",
                      selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-background text-muted-foreground",
                    )}
                  >
                    <WebhookProviderIcon provider={item} className="size-4 shrink-0" />
                    <span className="truncate">{itemMeta.label}</span>
                  </div>
                );
              })}
            </div>

            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2",
                provider === "generic"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              <WebhookProviderIcon provider="generic" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{genericMeta.label}</span>
              <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden />
            </div>
          </div>

          <div className="flex min-w-0 flex-col justify-between gap-4 bg-background p-4 sm:p-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <WebhookProviderIcon provider={provider} className="size-4 shrink-0" />
                  <span className="text-sm font-semibold text-foreground">New {meta.label} trigger</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{meta.shortDescription}</p>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-foreground">Name</div>
                <Input readOnly value={triggerName} aria-label="Trigger name" className="h-9 text-sm" />
              </div>

              {meta.secretMode === "optional" ? (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-foreground">Protect with a key</span>
                  <Switch checked disabled aria-label="Protect with a key" />
                </div>
              ) : null}

              <p className="text-xs leading-relaxed text-muted-foreground">
                {meta.secretMode === "generated"
                  ? `Next: Alook creates a private link and key for you to paste into ${meta.label}.`
                  : meta.secretMode === "external"
                    ? `Next: Alook creates a private link to paste into ${meta.label}, then you paste back the key ${meta.label} gives you.`
                    : "Next: Alook creates a private link and optional verification key."}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" disabled>
                Cancel
              </Button>
              <Button type="button" size="sm" className="h-9 px-3 text-xs">
                Create trigger
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs font-medium text-muted-foreground">02</span>
          <h3 className="text-base font-semibold tracking-[-0.015em] text-foreground">
            Copy your private Trigger link{meta.secretMode === "generated" ? " and Verification key" : ""}
          </h3>
        </div>

        <div className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
          <div className="flex items-center gap-2">
            <WebhookProviderIcon provider={provider} className="size-4 shrink-0" />
            <span className="text-sm font-semibold text-foreground">Trigger ready</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <CopyablePreviewField label="Trigger link" value={sampleUrl} />
            {meta.secretMode === "generated" ? (
              <CopyablePreviewField label="Verification key" value={sampleSecret} />
            ) : meta.secretMode === "external" ? (
              <div className="min-w-0 space-y-2 rounded-lg bg-muted/50 p-4">
                <div className="text-xs font-medium text-muted-foreground">Paste key from {meta.label}</div>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={meta.secretPlaceholder}
                    aria-label={`Paste key from ${meta.label}`}
                    className="h-9 min-w-0 flex-1 bg-background font-mono text-xs text-muted-foreground"
                  />
                  <Button type="button" variant="secondary" size="sm" className="h-9 shrink-0 px-3 text-xs">
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <CopyablePreviewField label="Verification key (optional)" value={sampleSecret} />
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs font-semibold text-foreground">Connect in {meta.label}</p>
            <ol className="list-decimal space-y-2 pl-4 text-sm leading-relaxed text-muted-foreground">
              {meta.setupSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs font-medium text-muted-foreground">03</span>
          <h3 className="text-base font-semibold tracking-[-0.015em] text-foreground">
            Paste into {meta.label} and verify Connected in Alook
          </h3>
        </div>

        <div className="grid divide-y divide-border overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] sm:divide-x sm:divide-y-0">
          <div className="min-w-0 space-y-4 bg-background p-4 sm:p-6">
            <div className="flex items-center gap-2 border-b border-border pb-4">
              <WebhookProviderIcon provider={provider} className="size-4 shrink-0" />
              <span className="truncate text-sm font-semibold text-foreground">{externalMenuPath}</span>
            </div>

            <div className="space-y-4">
              {externalFields.map((field) => (
                <div key={field.label} className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">{field.label}</div>
                  <div
                    className={cn(
                      "truncate rounded-md border border-input bg-muted/35 px-3 py-2 text-sm text-foreground",
                      field.mono ? "font-mono text-xs" : "",
                    )}
                  >
                    {field.value}
                  </div>
                </div>
              ))}

              {externalEvents.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Selected events</div>
                  <div className="flex flex-wrap gap-2">
                    {externalEvents.map((eventName) => (
                      <span
                        key={eventName}
                        className="inline-flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-2 py-1 text-xs font-medium text-foreground"
                      >
                        <Check className="size-3.5 text-primary" aria-hidden />
                        <span>{eventName}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex justify-end">
                <span className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground">
                  {externalSubmitLabel}
                </span>
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-col justify-between gap-4 p-4 sm:p-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 border-b border-border pb-4">
                <div className="flex items-center gap-2">
                  <Link2 className="size-4 text-muted-foreground" aria-hidden />
                  <span className="text-sm font-semibold text-foreground">Alook · Triggers</span>
                </div>
                <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
                  <span className="size-1.5 rounded-full bg-status-online" aria-hidden />
                  <span>Connected</span>
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <WebhookProviderIcon provider={provider} className="size-4 shrink-0" />
                  <span className="text-base font-semibold text-foreground">{triggerName}</span>
                </div>
                <p className="text-xs text-muted-foreground">{meta.label} · Last triggered just now</p>
              </div>

              <div className="space-y-2 rounded-lg bg-muted/50 p-4">
                <div className="text-xs font-medium text-muted-foreground">Recent triggers</div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="size-1.5 shrink-0 rounded-full bg-status-online" aria-hidden />
                  <span className="font-semibold text-foreground">Just now</span>
                  <span className="text-muted-foreground">Connected</span>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{connectedSummary}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
              <Shield className="size-3.5 shrink-0 text-primary" aria-hidden />
              <span>Signature verified · Private to {botName}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

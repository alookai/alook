"use client";

import { motion, useReducedMotion } from "motion/react";
import { BOT_WEBHOOK_PROVIDER_META, type BotWebhookProvider } from "@alook/shared";
import { AgentAvatar } from "@/components/avatar";
import { WebhookProviderIcon } from "@/components/community/bots/webhook-provider-icon";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Hash,
} from "@/components/icons/lucide";
import { cn } from "@/lib/utils";
import type { TriggerExternalStatus, TriggerFlowStage } from "./trigger-flow-demo";

function statusPillClasses(status: TriggerExternalStatus) {
  switch (status) {
    case "open":
    case "passing":
      return {
        solid: "bg-[#1f883d] text-white dark:bg-[#238636]",
        soft: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
        Icon: status === "open" ? CircleDot : CircleCheck,
      };
    case "failing":
    case "alert":
      return {
        solid: "bg-[#cf222e] text-white dark:bg-[#da3633]",
        soft: "bg-red-500/15 text-red-700 dark:bg-red-500/20 dark:text-red-300",
        Icon: CircleAlert,
      };
    case "merged":
      return {
        solid: "bg-[#8250df] text-white dark:bg-[#8957e5]",
        soft: "bg-purple-500/15 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300",
        Icon: CircleCheck,
      };
    case "info":
      return {
        solid: "bg-[#636c76] text-white",
        soft: "bg-zinc-500/15 text-zinc-700 dark:bg-zinc-500/25 dark:text-zinc-300",
        Icon: CircleDot,
      };
  }
}

export function TriggerExternalSurface({
  provider,
  stage,
  isWritebackTarget,
}: {
  provider: BotWebhookProvider;
  stage: TriggerFlowStage;
  isWritebackTarget: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const meta = BOT_WEBHOOK_PROVIDER_META[provider];
  const ext = stage.external;
  const tone = statusPillClasses(ext.status);
  const StatusIcon = tone.Icon;

  const animatedBody = (content: React.ReactNode, className = "flex flex-1 flex-col gap-2.5 p-3.5") => (
    <motion.div
      key={`${stage.id}-ext`}
      initial={reducedMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={className}
    >
      {content}
    </motion.div>
  );

  const ringClass = isWritebackTarget
    ? "border-[#8250df]/75 dark:border-[#a371f7]"
    : "border-[#d0d7de] dark:border-[#30363d]";

  // 1. GitHub — Authentic Primer Repo / Issues / Actions / PR chrome
  if (provider === "github") {
    const parts = (ext.workspace ?? ext.header).split("/").map((p) => p.trim());
    return (
      <section
        aria-label={`${meta.label} workspace`}
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white text-[#1f2328] transition-colors dark:bg-[#0d1117] dark:text-[#e6edf3]",
          ringClass,
        )}
      >
        <div className="border-b border-[#d0d7de] bg-[#f6f8fa] dark:border-[#30363d] dark:bg-[#010409]">
          <div className="flex items-center justify-between gap-2 px-3.5 pt-2.5 pb-1.5">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <WebhookProviderIcon provider="github" className="size-4.5 shrink-0 text-[#1f2328] dark:text-[#e6edf3]" />
              <span className="truncate">
                {parts.length >= 2 ? (
                  <>
                    <span className="text-[#636c76] dark:text-[#8b949e]">{parts[0]}</span>
                    <span className="mx-1 text-[#636c76] dark:text-[#8b949e]">/</span>
                    <span className="font-semibold">{parts[1]}</span>
                  </>
                ) : (
                  <span className="font-semibold">{ext.workspace ?? meta.label}</span>
                )}
              </span>
            </div>
            <span className="shrink-0 rounded-full border border-[#d0d7de] px-1.5 py-0.5 text-[10px] font-medium text-[#636c76] dark:border-[#30363d] dark:text-[#8b949e]">
              Public
            </span>
          </div>
          <div className="flex items-center gap-3.5 px-3.5 text-[11px] font-medium text-[#636c76] dark:text-[#8b949e]">
            {(
              [
                { key: "issues", label: "Issues" },
                { key: "pulls", label: "Pull requests" },
                { key: "actions", label: "Actions" },
              ] as const
            ).map((navItem) => {
              const active = (ext.tab ?? "issues") === navItem.key;
              return (
                <span
                  key={navItem.key}
                  className={cn("relative py-1.5 whitespace-nowrap", active ? "font-semibold text-[#1f2328] dark:text-[#e6edf3]" : "")}
                >
                  {navItem.label}
                  {active ? <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[#fd8c73]" /> : null}
                </span>
              );
            })}
          </div>
        </div>
        {animatedBody(
          <>
            <div className="text-[14px] font-semibold leading-snug text-pretty">
              <span>{ext.title}</span>
              {ext.number ? <span className="ml-1.5 font-normal text-[#636c76] dark:text-[#8b949e]">{ext.number}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#d8dee4] pb-2.5 dark:border-[#21262d]">
              <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold", tone.solid)}>
                <StatusIcon className="size-3 shrink-0" aria-hidden />
                <span>{ext.statusLabel}</span>
              </span>
              {ext.labelTag ? (
                <span className="rounded-full border border-[#0969da]/30 bg-[#ddf4ff] px-2 py-0.5 font-mono text-[10px] font-medium text-[#0969da] dark:border-[#388bfd]/35 dark:bg-[#1f6feb]/20 dark:text-[#58a6ff]">
                  {ext.labelTag}
                </span>
              ) : null}
            </div>
            <div className="text-xs leading-relaxed text-[#57606a] dark:text-[#8b949e] text-pretty">{ext.detail}</div>
            {ext.checks && ext.checks.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-[#d0d7de] divide-y divide-[#d8dee4] dark:border-[#30363d] dark:divide-[#21262d]">
                {ext.checks.map((check) => (
                  <div key={check.name} className="flex items-center justify-between gap-2 bg-[#f6f8fa]/70 px-2.5 py-1.5 text-[11px] dark:bg-[#161b22]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {check.status === "pass" ? (
                        <CircleCheck className="size-3.5 shrink-0 text-[#1a7f37] dark:text-[#3fb950]" aria-hidden />
                      ) : (
                        <CircleAlert className="size-3.5 shrink-0 text-[#cf222e] dark:text-[#f85149]" aria-hidden />
                      )}
                      <span className="truncate font-mono">{check.name}</span>
                    </span>
                    {check.duration ? <span className="shrink-0 font-mono text-[10px] text-[#636c76] dark:text-[#8b949e]">{check.duration}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {ext.logLines && ext.logLines.length > 0 ? (
              <div className="overflow-x-auto thin-scrollbar rounded-md bg-[#0d1117] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#e6edf3] dark:border dark:border-[#30363d]">
                {ext.logLines.map((line, i) => (
                  <div key={i} className={cn("whitespace-nowrap", i === 0 ? "text-[#ff7b72]" : "text-[#c9d1d9]")}>
                    {line}
                  </div>
                ))}
              </div>
            ) : ext.meta ? (
              <div className="overflow-x-auto thin-scrollbar rounded-md border border-[#d0d7de] bg-[#f6f8fa] px-2.5 py-1.5 font-mono text-[11px] dark:border-[#30363d] dark:bg-[#161b22]">
                {ext.meta}
              </div>
            ) : null}
            {ext.reply ? (
              <div className="mt-auto overflow-hidden rounded-md border border-[#0969da]/35 dark:border-[#388bfd]/45">
                <div className="flex items-center gap-1.5 border-b border-[#0969da]/20 bg-[#ddf4ff]/65 px-2.5 py-1.5 text-[11px] dark:border-[#388bfd]/25 dark:bg-[#1f6feb]/15">
                  <AgentAvatar name={ext.reply.author} seed={ext.reply.author.toLowerCase()} size={16} className="shrink-0" />
                  <span className="font-semibold">{ext.reply.author}</span>
                  <span className="text-[#57606a] dark:text-[#8b949e]">commented now</span>
                </div>
                <div className="bg-white px-2.5 py-2 text-xs leading-relaxed dark:bg-[#0d1117] text-pretty">
                  {ext.reply.text}
                </div>
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 2. Linear — Signature sleek dark issue tracker chrome
  if (provider === "linear") {
    return (
      <section
        aria-label="Linear workspace"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-[#101116] text-[#f4f5f8] transition-colors",
          isWritebackTarget ? "border-[#5e6ad2]" : "border-[#262834]",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[#222430] bg-[#14161e] px-3.5 py-2 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <WebhookProviderIcon provider="linear" className="size-4 shrink-0 text-[#8a94ff]" />
            <span className="truncate text-[#8a8f98]">{ext.workspace ?? "Mossnote"}</span>
            <span className="text-[#4c5163]">›</span>
            <span className="shrink-0 font-mono text-[11px] font-medium text-[#e2e4ec]">{ext.number ?? ext.header}</span>
          </div>
          <span className="shrink-0 rounded border border-[#2c2f3e] bg-[#1a1c26] px-1.5 py-0.5 text-[10px] text-[#a5abbd]">
            {ext.labelTag ?? "Cycle 14"}
          </span>
        </div>
        {animatedBody(
          <>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                  ext.status === "merged" || ext.status === "passing"
                    ? "border-[#5e6ad2]/50 bg-[#5e6ad2]/20 text-[#b4bcff]"
                    : ext.status === "open"
                      ? "border-amber-400/40 bg-amber-400/15 text-amber-300"
                      : "border-[#2c2f3e] bg-[#1a1c26] text-[#d0d4e0]",
                )}
              >
                <StatusIcon className="size-3 shrink-0" aria-hidden />
                <span>{ext.statusLabel}</span>
              </span>
              {ext.meta ? <span className="truncate font-mono text-[11px] text-[#8a8f98]">{ext.meta}</span> : null}
            </div>
            <div className="text-[14px] font-semibold leading-snug text-[#f7f8fa] text-pretty">{ext.title}</div>
            <div className="text-xs leading-relaxed text-[#9ca2b2] text-pretty">{ext.detail}</div>
            {ext.metrics && ext.metrics.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {ext.metrics.map((m) => (
                  <span key={m.label} className="inline-flex items-center gap-1 rounded border border-[#272937] bg-[#171923] px-2 py-0.5 text-[10px] text-[#a6acbe]">
                    <span className="text-[#6f7588]">{m.label}</span>
                    <span className="font-medium text-[#e6e8f0]">{m.value}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {ext.reply ? (
              <div className="mt-auto rounded-lg border border-[#5e6ad2]/40 bg-[#171926] p-2.5">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <AgentAvatar name={ext.reply.author} seed={ext.reply.author.toLowerCase()} size={16} className="shrink-0" />
                  <span className="font-semibold text-[#f4f5f8]">{ext.reply.author}</span>
                  <span className="text-[#8a8f98]">updated status & commented</span>
                </div>
                <div className="mt-1.5 text-xs leading-relaxed text-[#d7dae4] text-pretty">{ext.reply.text}</div>
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 3. Sentry — Plum top bar + Unresolved/Resolved + Stack Trace + Events/Users
  if (provider === "sentry") {
    return (
      <section
        aria-label="Sentry workspace"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white text-[#1f192b] transition-colors dark:bg-[#17131f] dark:text-[#f2eef9]",
          isWritebackTarget ? "border-emerald-500/70" : "border-[#dcd6e6] dark:border-[#322945]",
        )}
      >
        <div className="flex items-center justify-between gap-2 bg-[#2b2240] px-3.5 py-2 text-xs text-white">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-white/12">
              <WebhookProviderIcon provider="sentry" className="size-3.5 shrink-0 fill-white" />
            </span>
            <span className="font-semibold">Sentry</span>
            <span className="truncate font-mono text-[11px] text-white/70">{ext.workspace ?? "mossnote-web"}</span>
          </div>
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase",
              ext.status === "passing" || ext.status === "merged"
                ? "bg-emerald-500/25 text-emerald-200"
                : "bg-red-500/30 text-red-200",
            )}
          >
            {ext.statusLabel}
          </span>
        </div>
        {animatedBody(
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-xs font-bold text-[#cf222e] dark:text-[#ff7b72]">
                {ext.number ?? "TypeError"}
              </span>
              {ext.labelTag ? (
                <span className="rounded bg-[#f3eefc] px-1.5 py-0.5 font-mono text-[10px] text-[#58478a] dark:bg-[#2a2140] dark:text-[#c7b8f5]">
                  {ext.labelTag}
                </span>
              ) : null}
            </div>
            <div className="text-[13px] font-semibold leading-snug text-pretty">{ext.title}</div>
            <div className="text-xs leading-relaxed text-[#5c536e] dark:text-[#a69cb8] text-pretty">{ext.detail}</div>
            {ext.metrics && ext.metrics.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 rounded-md border border-[#e5dfef] bg-[#faf8fd] px-2.5 py-1.5 dark:border-[#322945] dark:bg-[#211b2e]">
                {ext.metrics.map((m) => (
                  <div key={m.label} className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-[#7a6f8f] dark:text-[#9c90b5]">{m.label}</div>
                    <div className="truncate font-mono text-xs font-semibold">{m.value}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {ext.logLines && ext.logLines.length > 0 ? (
              <div className="overflow-x-auto thin-scrollbar rounded-md border border-[#e5dfef] bg-[#1a1526] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#e8e3f5] dark:border-[#322945]">
                {ext.logLines.map((line, i) => (
                  <div key={i} className={cn("whitespace-nowrap", i === 0 ? "text-[#ff8f8f]" : "text-[#bfb4db]")}>
                    {line}
                  </div>
                ))}
              </div>
            ) : null}
            {ext.reply ? (
              <div className="mt-auto rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-2 text-xs text-pretty">
                <span className="font-semibold">{ext.reply.author}: </span>
                <span>{ext.reply.text}</span>
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 4. Stripe — Crisp white + Blurple #635bff + Big tabular amount + Dispute/Payment rows
  if (provider === "stripe") {
    return (
      <section
        aria-label="Stripe workspace"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white text-[#1a1f36] transition-colors dark:bg-[#111420] dark:text-[#f6f9fc]",
          isWritebackTarget ? "border-[#635bff]" : "border-[#e3e8ee] dark:border-[#2a314a]",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[#e3e8ee] bg-[#f7fafc] px-3.5 py-2 text-xs dark:border-[#2a314a] dark:bg-[#161b2c]">
          <div className="flex min-w-0 items-center gap-2">
            <WebhookProviderIcon provider="stripe" className="size-4 shrink-0" />
            <span className="font-semibold text-[#635bff] dark:text-[#8f89ff]">Stripe</span>
            <span className="truncate text-[#697386] dark:text-[#98a3b8]">{ext.workspace ?? "Payments"}</span>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-[#697386] dark:text-[#98a3b8]">{ext.number ?? "Live"}</span>
        </div>
        {animatedBody(
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-lg font-bold tracking-tight tabular-nums">
                {ext.amount ?? "$240.00 USD"}
              </span>
              <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", tone.soft)}>
                <StatusIcon className="size-3 shrink-0" aria-hidden />
                <span>{ext.statusLabel}</span>
              </span>
            </div>
            <div className="text-[13px] font-semibold leading-snug text-pretty">{ext.title}</div>
            <div className="text-xs leading-relaxed text-[#4f566b] dark:text-[#9aa5b8] text-pretty">{ext.detail}</div>
            {ext.metrics && ext.metrics.length > 0 ? (
              <div className="divide-y divide-[#e3e8ee] rounded-md border border-[#e3e8ee] text-xs dark:divide-[#2a314a] dark:border-[#2a314a]">
                {ext.metrics.map((m) => (
                  <div key={m.label} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                    <span className="text-[#697386] dark:text-[#98a3b8]">{m.label}</span>
                    <span className="truncate font-mono text-[11px] font-medium">{m.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {ext.reply ? (
              <div className="mt-auto rounded-md border border-[#635bff]/35 bg-[#635bff]/8 px-2.5 py-2 text-xs text-pretty">
                <span className="font-semibold text-[#635bff] dark:text-[#a5a0ff]">{ext.reply.author}: </span>
                <span>{ext.reply.text}</span>
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 5. Vercel — Stark monochrome + Triangle ▲ + Preview/Build logs
  if (provider === "vercel") {
    return (
      <section
        aria-label="Vercel workspace"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white text-[#111111] transition-colors dark:bg-[#0a0a0a] dark:text-[#ededed]",
          isWritebackTarget ? "border-emerald-500/75" : "border-[#eaeaea] dark:border-[#2a2a2a]",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[#eaeaea] bg-[#fafafa] px-3.5 py-2 text-xs dark:border-[#262626] dark:bg-[#111111]">
          <div className="flex min-w-0 items-center gap-2">
            <WebhookProviderIcon provider="vercel" className="size-3.5 shrink-0" />
            <span className="truncate font-medium">{ext.workspace ?? "mossnote / web"}</span>
          </div>
          <span className="shrink-0 rounded-full border border-[#eaeaea] px-2 py-0.5 text-[10px] font-medium text-[#666] dark:border-[#333] dark:text-[#a1a1a1]">
            {ext.labelTag ?? "Preview"}
          </span>
        </div>
        {animatedBody(
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    ext.status === "failing" || ext.status === "alert"
                      ? "bg-[#e00]"
                      : ext.status === "passing" || ext.status === "merged"
                        ? "bg-[#00a86b]"
                        : "bg-amber-500",
                  )}
                />
                <span>{ext.statusLabel}</span>
              </span>
              {ext.number ? <span className="font-mono text-[11px] text-[#666] dark:text-[#888]">{ext.number}</span> : null}
            </div>
            <div className="text-[13px] font-semibold leading-snug text-pretty">{ext.title}</div>
            <div className="text-xs leading-relaxed text-[#666] dark:text-[#a1a1a1] text-pretty">{ext.detail}</div>
            {ext.logLines && ext.logLines.length > 0 ? (
              <div className="overflow-x-auto thin-scrollbar rounded-md bg-[#0a0a0a] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#ededed] dark:border dark:border-[#262626]">
                {ext.logLines.map((line, i) => (
                  <div key={i} className={cn("whitespace-nowrap", i === 0 ? "text-[#ff6166]" : "text-[#a1a1a1]")}>
                    {line}
                  </div>
                ))}
              </div>
            ) : null}
            {ext.meta ? (
              <div className="mt-auto truncate rounded-md border border-[#eaeaea] bg-[#fafafa] px-2.5 py-1.5 font-mono text-[11px] text-[#0070f3] dark:border-[#262626] dark:bg-[#141414] dark:text-[#52a8ff]">
                {ext.meta}
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 6. GitLab — Tanuki orange bar + MR / Pipelines tabs + Circular stage pipeline graph
  if (provider === "gitlab") {
    return (
      <section
        aria-label="GitLab workspace"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white text-[#1f1e24] transition-colors dark:bg-[#18171d] dark:text-[#ececef]",
          ringClass,
        )}
      >
        <div className="h-1 bg-[#fc6d26]" />
        <div className="flex items-center justify-between gap-2 border-b border-[#dcdcde] bg-[#fbfafd] px-3.5 py-2 text-xs dark:border-[#2f2d38] dark:bg-[#1f1e26]">
          <div className="flex min-w-0 items-center gap-2">
            <WebhookProviderIcon provider="gitlab" className="size-4 shrink-0" />
            <span className="truncate font-semibold">{ext.workspace ?? "mossnote / core"}</span>
          </div>
          <span className="shrink-0 font-mono text-[11px] font-medium text-[#737278] dark:text-[#a4a3a8]">
            {ext.number ?? "!142"}
          </span>
        </div>
        {animatedBody(
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", tone.solid)}>
                <StatusIcon className="size-3 shrink-0" aria-hidden />
                <span>{ext.statusLabel}</span>
              </span>
              {ext.labelTag ? (
                <span className="rounded bg-[#ececef] px-1.5 py-0.5 font-mono text-[10px] text-[#3a3842] dark:bg-[#2a2933] dark:text-[#d0cfd6]">
                  {ext.labelTag}
                </span>
              ) : null}
            </div>
            <div className="text-[13px] font-semibold leading-snug text-pretty">{ext.title}</div>
            <div className="text-xs leading-relaxed text-[#626168] dark:text-[#a4a3a8] text-pretty">{ext.detail}</div>
            {ext.checks && ext.checks.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-[#dcdcde] bg-[#fbfafd] px-2.5 py-2 dark:border-[#2f2d38] dark:bg-[#222129]">
                {ext.checks.map((stageItem, idx) => (
                  <div key={stageItem.name} className="flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-full border border-[#dcdcde] bg-white px-2 py-0.5 font-mono text-[10px] dark:border-[#3a3845] dark:bg-[#18171d]">
                      {stageItem.status === "pass" ? (
                        <CircleCheck className="size-3 text-[#108548] dark:text-[#2da160]" aria-hidden />
                      ) : (
                        <CircleAlert className="size-3 text-[#dd2b0e] dark:text-[#ff6b57]" aria-hidden />
                      )}
                      <span>{stageItem.name}</span>
                    </span>
                    {idx < ext.checks!.length - 1 ? <span className="text-[#a4a3a8]">→</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {ext.reply ? (
              <div className="mt-auto rounded-md border border-[#1f75cb]/35 bg-[#e9f3fc]/60 px-2.5 py-2 text-xs dark:bg-[#1f75cb]/15 text-pretty">
                <span className="font-semibold">{ext.reply.author}: </span>
                <span>{ext.reply.text}</span>
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 7. Slack — Unmistakable #3f0e40 aubergine left sidebar + square Slack avatars + Thread
  if (provider === "slack") {
    return (
      <section
        aria-label="Slack workspace"
        className={cn(
          "grid min-w-0 grid-cols-[62px_minmax(0,1fr)] overflow-hidden rounded-xl border bg-white text-[#1d1c1d] transition-colors dark:bg-[#1a1d21] dark:text-[#d1d2d3]",
          isWritebackTarget ? "border-[#1264a3]" : "border-[#dcdcdc] dark:border-[#35373b]",
        )}
      >
        <div aria-hidden="true" className="flex flex-col gap-1.5 bg-[#3f0e40] p-2 text-[10px] text-white/75">
          <div className="flex items-center gap-1 pb-1 font-bold text-white">
            <WebhookProviderIcon provider="slack" className="size-3.5 shrink-0" />
            <span className="truncate">Acme</span>
          </div>
          <span className="truncate rounded bg-[#1164a3] px-1.5 py-0.5 font-semibold text-white">
            #{ext.labelTag ?? "vip"}
          </span>
          <span className="truncate px-1.5 py-0.5 opacity-70">#help</span>
          <span className="truncate px-1.5 py-0.5 opacity-70">#ops</span>
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-[#e8e8e8] px-3 py-2 text-xs dark:border-[#2e3136]">
            <span className="flex min-w-0 items-center gap-1 font-bold">
              <Hash className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{ext.workspace ?? "vip-acme"}</span>
            </span>
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", tone.soft)}>
              {ext.statusLabel}
            </span>
          </div>
          {animatedBody(
            <>
              <div className="flex items-start gap-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[#1264a3] text-[11px] font-bold text-white">
                  S
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xs font-bold">{ext.number ?? "Sam (Customer)"}</span>
                    <span className="text-[10px] text-[#616061] dark:text-[#ababad]">10:14 AM</span>
                  </div>
                  <div className="mt-0.5 text-xs font-medium leading-snug text-pretty">{ext.title}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-[#616061] dark:text-[#ababad] text-pretty">
                    {ext.detail}
                  </div>
                </div>
              </div>
              {ext.reply ? (
                <div className="mt-auto border-l-2 border-[#1264a3] pl-2.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="font-bold">{ext.reply.author}</span>
                    <span className="shrink-0 whitespace-nowrap rounded bg-[#e8e8e8] px-1 text-[9px] font-semibold text-[#616061] dark:bg-[#2c2d30] dark:text-[#ababad]">
                      APP
                    </span>
                    <span className="whitespace-nowrap text-[10px] text-[#1264a3] dark:text-[#4ea5e8]">Replied in thread</span>
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-pretty">{ext.reply.text}</div>
                </div>
              ) : null}
            </>,
            "flex flex-1 flex-col gap-2.5 p-3",
          )}
        </div>
      </section>
    );
  }

  // 8. Grafana — Dark observability panel + Orange top accent + Inline SVG latency sparkline chart
  if (provider === "grafana") {
    const isResolved = ext.status === "passing" || ext.status === "merged";
    return (
      <section
        aria-label="Grafana workspace"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-[#111217] text-[#ccccdc] transition-colors",
          isWritebackTarget ? "border-emerald-500/70" : "border-[#262933]",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[#242731] bg-[#181b1f] px-3.5 py-2 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <WebhookProviderIcon provider="grafana" className="size-4 shrink-0" />
            <span className="font-semibold text-white">Grafana</span>
            <span className="truncate font-mono text-[11px] text-[#8e93a2]">{ext.workspace ?? "Alerting"}</span>
          </div>
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase",
              isResolved ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/25 text-red-300",
            )}
          >
            {ext.statusLabel}
          </span>
        </div>
        {animatedBody(
          <>
            <div className="text-[13px] font-semibold leading-snug text-white text-pretty">{ext.title}</div>
            {/* Authentic mini Grafana time-series panel */}
            <div className="rounded-md border border-[#262933] bg-[#181b1f] p-2.5">
              <div className="mb-1.5 flex items-center justify-between text-[10px] font-mono text-[#8e93a2]">
                <span>{ext.labelTag ?? "p95 latency (ms)"}</span>
                <span className={isResolved ? "text-emerald-400" : "text-[#ff7b72]"}>{ext.amount ?? (isResolved ? "118 ms" : "1,420 ms")}</span>
              </div>
              <svg viewBox="0 0 220 48" className="h-12 w-full" aria-hidden="true">
                <line x1="0" y1="18" x2="220" y2="18" stroke="#f2495c" strokeDasharray="3 3" strokeOpacity="0.55" strokeWidth="1" />
                {isResolved ? (
                  <polyline
                    fill="none"
                    stroke="#73bf69"
                    strokeWidth="2"
                    points="2,10 38,8 70,12 104,34 140,38 180,39 218,38"
                  />
                ) : (
                  <polyline
                    fill="none"
                    stroke="#ff780a"
                    strokeWidth="2"
                    points="2,38 40,36 78,37 115,28 152,11 186,7 218,9"
                  />
                )}
              </svg>
            </div>
            <div className="text-xs leading-relaxed text-[#9fa4b5] text-pretty">{ext.detail}</div>
            {ext.reply ? (
              <div className="mt-auto rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200 text-pretty">
                {ext.reply.text}
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 9. Datadog — Signature #632ca6 purple top bar + Monitor state + Service tag pills
  if (provider === "datadog") {
    const isOk = ext.status === "passing" || ext.status === "merged";
    return (
      <section
        aria-label="Datadog workspace"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white text-[#1e1a24] transition-colors dark:bg-[#14121a] dark:text-[#f2eff7]",
          isWritebackTarget ? "border-emerald-500/70" : "border-[#dcd5e8] dark:border-[#312942]",
        )}
      >
        <div className="flex items-center justify-between gap-2 bg-[#632ca6] px-3.5 py-2 text-xs text-white">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-white/15">
              <WebhookProviderIcon provider="datadog" className="size-3.5 shrink-0 fill-white" />
            </span>
            <span className="font-semibold">Datadog</span>
            <span className="truncate font-mono text-[11px] text-white/75">{ext.workspace ?? "Monitors"}</span>
          </div>
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase",
              isOk ? "bg-emerald-400/25 text-emerald-100" : "bg-red-500/40 text-white",
            )}
          >
            {ext.statusLabel}
          </span>
        </div>
        {animatedBody(
          <>
            <div className="text-[13px] font-semibold leading-snug text-pretty">{ext.title}</div>
            {ext.tags && ext.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {ext.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded border border-[#d6c9eb] bg-[#f4effb] px-1.5 py-0.5 font-mono text-[10px] text-[#572694] dark:border-[#3e2f5c] dark:bg-[#231936] dark:text-[#cdb6f5]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="text-xs leading-relaxed text-[#5c5468] dark:text-[#a89eb8] text-pretty">{ext.detail}</div>
            {ext.metrics && ext.metrics.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 rounded-md border border-[#e6dff0] bg-[#faf8fd] px-2.5 py-1.5 dark:border-[#312942] dark:bg-[#1c1826]">
                {ext.metrics.map((m) => (
                  <div key={m.label} className="min-w-0">
                    <div className="text-[10px] text-[#786e8a] dark:text-[#9c90b5]">{m.label}</div>
                    <div className="truncate font-mono text-xs font-semibold">{m.value}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {ext.reply ? (
              <div className="mt-auto rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-pretty">
                <span className="font-semibold">{ext.reply.author}: </span>
                <span>{ext.reply.text}</span>
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 10. n8n — Signature #ea4b71 rose header + dotted workflow canvas + connected nodes
  if (provider === "n8n") {
    const nodes = ext.nodes ?? ["RSS", "Filter", "Alook", "Notion"];
    return (
      <section
        aria-label="n8n workspace"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white text-[#1f1b24] transition-colors dark:bg-[#17151c] dark:text-[#f2f0f5]",
          isWritebackTarget ? "border-[#ea4b71]" : "border-[#e4dfe9] dark:border-[#312d3a]",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[#e4dfe9] bg-[#fdfafc] px-3.5 py-2 text-xs dark:border-[#312d3a] dark:bg-[#1e1b24]">
          <div className="flex min-w-0 items-center gap-2">
            <WebhookProviderIcon provider="n8n" className="size-4 shrink-0" />
            <span className="font-semibold">n8n</span>
            <span className="truncate text-[#746d7e] dark:text-[#a29aad]">{ext.workspace ?? "Workflow"}</span>
          </div>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", tone.soft)}>
            {ext.statusLabel}
          </span>
        </div>
        {animatedBody(
          <>
            {/* Dotted n8n canvas with mini node chain */}
            <div
              className="rounded-lg border border-[#e4dfe9] bg-[#fafafa] p-2.5 dark:border-[#312d3a] dark:bg-[#121016]"
              style={{
                backgroundImage: "radial-gradient(circle, rgba(140,130,155,0.28) 1px, transparent 1px)",
                backgroundSize: "10px 10px",
              }}
            >
              <div className="flex flex-wrap items-center gap-1">
                {nodes.map((node, idx) => (
                  <div key={node} className="flex items-center gap-1">
                    <span
                      className={cn(
                        "rounded-md border px-2 py-1 font-mono text-[10px] font-medium shadow-2xs",
                        idx === nodes.length - 1 && isWritebackTarget
                          ? "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : node.toLowerCase().includes("alook") || node.toLowerCase().includes("http")
                            ? "border-[#ea4b71] bg-[#ea4b71]/12 text-[#c93459] dark:text-[#ff8aa6]"
                            : "border-[#d8d3df] bg-white text-[#2f2a36] dark:border-[#3a3545] dark:bg-[#211e29] dark:text-[#e5e1ec]",
                      )}
                    >
                      {node}
                    </span>
                    {idx < nodes.length - 1 ? <ArrowRight className="size-3 text-[#9a92a6]" aria-hidden /> : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="text-[13px] font-semibold leading-snug text-pretty">{ext.title}</div>
            <div className="text-xs leading-relaxed text-[#645d6e] dark:text-[#a29aad] text-pretty">{ext.detail}</div>
            {ext.reply ? (
              <div className="mt-auto rounded-md border border-[#ea4b71]/35 bg-[#ea4b71]/8 px-2.5 py-1.5 text-xs text-pretty">
                <span className="font-semibold">{ext.reply.author}: </span>
                <span>{ext.reply.text}</span>
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 11. Custom app (generic) — Authentic macOS Terminal window running curl POST
  if (provider === "generic") {
    return (
      <section
        aria-label="Custom app terminal"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-[#0d1117] text-[#e6edf3] transition-colors",
          isWritebackTarget ? "border-emerald-500/75" : "border-[#30363d]",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[#21262d] bg-[#161b22] px-3.5 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1" aria-hidden="true">
              <span className="size-2.5 rounded-full bg-[#ff5f56]" />
              <span className="size-2.5 rounded-full bg-[#ffbd2e]" />
              <span className="size-2.5 rounded-full bg-[#27c93f]" />
            </span>
            <span className="truncate font-mono text-[11px] text-[#8b949e]">{ext.workspace ?? "zsh · gpu-train-01"}</span>
          </div>
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
              ext.status === "failing" || ext.status === "alert"
                ? "bg-red-500/25 text-red-300"
                : "bg-emerald-500/20 text-emerald-300",
            )}
          >
            {ext.statusLabel}
          </span>
        </div>
        {animatedBody(
          <>
            <div className="text-[13px] font-semibold leading-snug text-white text-pretty">{ext.title}</div>
            {ext.logLines && ext.logLines.length > 0 ? (
              <div className="overflow-x-auto thin-scrollbar rounded-md border border-[#21262d] bg-[#010409] px-2.5 py-2 font-mono text-[11px] leading-relaxed">
                {ext.logLines.map((line, i) => (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-nowrap",
                      line.startsWith("$") ? "text-[#79c0ff]" : line.includes("FAIL") || line.includes("ERR") ? "text-[#ff7b72]" : "text-[#c9d1d9]",
                    )}
                  >
                    {line}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="text-xs leading-relaxed text-[#8b949e] text-pretty">{ext.detail}</div>
            {ext.reply ? (
              <div className="mt-auto rounded-md border border-emerald-500/35 bg-emerald-500/12 px-2.5 py-1.5 font-mono text-[11px] text-emerald-200 text-pretty">
                {ext.reply.text}
              </div>
            ) : null}
          </>,
        )}
      </section>
    );
  }

  // 12–19. OpenAI / Resend / Clerk / Polar / Cloudflare + IM — Brand-authentic surfaces
  const brandStyle: Record<
    "openai" | "resend" | "clerk" | "polar" | "cloudflare" | "telegram" | "feishu" | "wechat",
    { bar: string; accentText: string; surface: string; border: string }
  > = {
    telegram: {
      bar: "bg-[#f0f9ff] text-[#0c4a6e] border-[#bae6fd] dark:bg-[#0c1d2b] dark:text-[#e0f2fe] dark:border-[#1e3a52]",
      accentText: "text-[#26a5e4]",
      surface: "bg-white text-[#0f172a] dark:bg-[#0e1621] dark:text-[#f1f5f9]",
      border: "border-[#bae6fd] dark:border-[#1e3a52]",
    },
    feishu: {
      bar: "bg-[#eef6ff] text-[#1d2129] border-[#cde2ff] dark:bg-[#101c2e] dark:text-[#f2f3f5] dark:border-[#1f3454]",
      accentText: "text-[#3370ff] dark:text-[#6698ff]",
      surface: "bg-white text-[#1d2129] dark:bg-[#11151d] dark:text-[#f2f3f5]",
      border: "border-[#cde2ff] dark:border-[#1f3454]",
    },
    wechat: {
      bar: "bg-[#f2fbf5] text-[#14331f] border-[#c8eed5] dark:bg-[#0f2216] dark:text-[#ecfdf3] dark:border-[#1f442d]",
      accentText: "text-[#07c160]",
      surface: "bg-white text-[#14331f] dark:bg-[#101713] dark:text-[#ecfdf3]",
      border: "border-[#c8eed5] dark:border-[#1f442d]",
    },
    openai: {
      bar: "bg-[#fafafa] text-[#171717] border-[#e5e5e5] dark:bg-[#171717] dark:text-[#fafafa] dark:border-[#2e2e2e]",
      accentText: "text-[#10a37f]",
      surface: "bg-white text-[#171717] dark:bg-[#111111] dark:text-[#f5f5f5]",
      border: "border-[#e5e5e5] dark:border-[#2e2e2e]",
    },
    resend: {
      bar: "bg-[#0a0a0a] text-[#fafafa] border-[#262626]",
      accentText: "text-[#38bdf8]",
      surface: "bg-[#111111] text-[#f5f5f5]",
      border: "border-[#262626]",
    },
    clerk: {
      bar: "bg-[#f8f7ff] text-[#1c192b] border-[#e5e0ff] dark:bg-[#181526] dark:text-[#f5f3ff] dark:border-[#322b52]",
      accentText: "text-[#6c47ff] dark:text-[#a68eff]",
      surface: "bg-white text-[#1c192b] dark:bg-[#12101c] dark:text-[#f5f3ff]",
      border: "border-[#e5e0ff] dark:border-[#322b52]",
    },
    polar: {
      bar: "bg-[#f5f9ff] text-[#0f172a] border-[#dbeafe] dark:bg-[#111827] dark:text-[#f8fafc] dark:border-[#1e3a5f]",
      accentText: "text-[#0062ff] dark:text-[#60a5fa]",
      surface: "bg-white text-[#0f172a] dark:bg-[#0d111a] dark:text-[#f8fafc]",
      border: "border-[#dbeafe] dark:border-[#1e3a5f]",
    },
    cloudflare: {
      bar: "bg-[#fff8f1] text-[#1d1f21] border-[#fed7aa] dark:bg-[#1c1917] dark:text-[#fafafa] dark:border-[#432c19]",
      accentText: "text-[#f38020]",
      surface: "bg-white text-[#1d1f21] dark:bg-[#141416] dark:text-[#f5f5f5]",
      border: "border-[#f0d9c2] dark:border-[#3d2b1d]",
    },
  };

  const b = brandStyle[provider];
  const isResendDark = provider === "resend";

  return (
    <section
      aria-label={`${meta.label} workspace`}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border transition-colors",
        b.surface,
        isWritebackTarget ? "border-emerald-500/70" : b.border,
      )}
    >
      <div className={cn("flex items-center justify-between gap-2 border-b px-3.5 py-2 text-xs", b.bar)}>
        <div className="flex min-w-0 items-center gap-2">
          <WebhookProviderIcon provider={provider} className="size-4 shrink-0" />
          <span className="shrink-0 font-semibold">{meta.label}</span>
          <span className="truncate font-mono text-[11px] opacity-70">{ext.workspace ?? ext.header}</span>
        </div>
        {ext.number ? <span className="shrink-0 font-mono text-[10px] opacity-75">{ext.number}</span> : null}
      </div>

      {animatedBody(
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", tone.soft)}>
              <StatusIcon className="size-3 shrink-0" aria-hidden />
              <span>{ext.statusLabel}</span>
            </span>
            {ext.amount ? (
              <span className="font-mono text-sm font-bold tabular-nums">{ext.amount}</span>
            ) : ext.labelTag ? (
              <span className={cn("truncate font-mono text-[11px] font-medium", b.accentText)}>{ext.labelTag}</span>
            ) : null}
          </div>

          <div className="text-[13px] font-semibold leading-snug text-pretty">{ext.title}</div>
          <div className={cn("text-xs leading-relaxed text-pretty", isResendDark ? "text-[#a1a1aa]" : "opacity-75")}>
            {ext.detail}
          </div>

          {ext.metrics && ext.metrics.length > 0 ? (
            <div
              className={cn(
                "divide-y rounded-md border text-xs",
                isResendDark
                  ? "divide-[#262626] border-[#262626] bg-[#171717]"
                  : "divide-border/70 border-border/70 bg-black/2 dark:bg-white/3",
              )}
            >
              {ext.metrics.map((m) => (
                <div key={m.label} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                  <span className="opacity-70">{m.label}</span>
                  <span className="truncate font-mono text-[11px] font-medium">{m.value}</span>
                </div>
              ))}
            </div>
          ) : null}

          {ext.checks && ext.checks.length > 0 ? (
            <div
              className={cn(
                "divide-y rounded-md border text-[11px]",
                isResendDark
                  ? "divide-[#262626] border-[#262626] bg-[#171717]"
                  : "divide-border/70 border-border/70 bg-black/2 dark:bg-white/3",
              )}
            >
              {ext.checks.map((c) => (
                <div key={c.name} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {c.status === "pass" ? (
                      <CircleCheck className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
                    ) : (
                      <CircleAlert className="size-3.5 shrink-0 text-red-500" aria-hidden />
                    )}
                    <span className="truncate font-mono">{c.name}</span>
                  </span>
                  {c.duration ? <span className="shrink-0 font-mono text-[10px] opacity-65">{c.duration}</span> : null}
                </div>
              ))}
            </div>
          ) : null}

          {ext.reply ? (
            <div
              className={cn(
                "mt-auto rounded-md border px-2.5 py-2 text-xs text-pretty",
                isResendDark
                  ? "border-[#38bdf8]/40 bg-[#38bdf8]/10 text-[#e0f2fe]"
                  : "border-emerald-500/35 bg-emerald-500/10",
              )}
            >
              <span className="font-semibold">{ext.reply.author}: </span>
              <span>{ext.reply.text}</span>
            </div>
          ) : null}
        </>,
      )}
    </section>
  );
}

"use client";

import { motion, useReducedMotion } from "motion/react";
import { BOT_WEBHOOK_PROVIDER_META, type BotWebhookProvider } from "@alook/shared";
import { AgentAvatar } from "@/components/avatar";
import { AnimatedAlookLogo } from "@/components/community/shell/animated-alook-logo";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Smile,
} from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTriggerFlowPlayback } from "../../hooks/use-trigger-flow-playback";
import { TriggerExternalSurface } from "./trigger-external-surface";

export type TriggerExternalStatus = "open" | "failing" | "passing" | "merged" | "alert" | "info";

type TriggerExternalCheck = {
  name: string;
  status: "pass" | "fail";
  duration?: string;
};

type TriggerExternalMetric = {
  label: string;
  value: string;
};

type TriggerFlowMessage = {
  author: string;
  role?: "bot" | "human";
  mentions?: readonly string[];
  text: string;
  meta?: string;
  time?: string;
};

export type TriggerFlowStage = {
  id: string;
  tabLabel: string;
  headline?: string;
  direction: "to-alook" | "to-external";
  signalLabel: string;
  signalTag?: string;
  external: {
    header: string;
    workspace?: string;
    tab?: "issues" | "pulls" | "actions";
    number?: string;
    labelTag?: string;
    amount?: string;
    status: TriggerExternalStatus;
    statusLabel: string;
    title: string;
    detail: string;
    meta?: string;
    checks?: readonly TriggerExternalCheck[];
    metrics?: readonly TriggerExternalMetric[];
    tags?: readonly string[];
    nodes?: readonly string[];
    logLines?: readonly string[];
    reply?: {
      author: string;
      text: string;
    };
  };
  messages: readonly TriggerFlowMessage[];
};

export type TriggerFlowDemoProps = {
  label: string;
  provider: BotWebhookProvider;
  channel: string;
  threadTitle: string;
  botName: string;
  serverInitial?: string;
  stages: readonly TriggerFlowStage[];
  initialStage?: number;
};

export function TriggerFlowDemo({
  label,
  provider,
  channel,
  threadTitle,
  botName,
  serverInitial = "M",
  stages,
  initialStage = 0,
}: TriggerFlowDemoProps) {
  const reducedMotion = Boolean(useReducedMotion());
  const { containerRef, activeIndex, playing, selectStage, togglePlay, replay } =
    useTriggerFlowPlayback({
      stageCount: stages.length,
      initialStage,
      reducedMotion,
    });

  const stage = stages[activeIndex] ?? stages[0];
  if (!stage) return null;

  const meta = BOT_WEBHOOK_PROVIDER_META[provider];
  const isToAlook = stage.direction === "to-alook";
  const bridgeTag = stage.signalTag ?? stage.signalLabel;
  const headline = stage.headline ?? stage.signalLabel;

  return (
    <figure
      ref={containerRef}
      data-guide-demo="trigger-flow"
      data-testid="trigger-flow-demo"
      data-provider={provider}
      data-active-stage={stage.id}
      aria-label={label}
      className="not-prose my-8 space-y-4 font-sans"
    >
      {/* Top step switcher + playback controls */}
      <div className="flex flex-col border-b border-border sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="Workflow steps"
          className="flex min-w-0 items-center gap-4 overflow-x-auto thin-scrollbar"
        >
          {stages.map((item, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectStage(index)}
                className={cn(
                  "relative min-h-11 shrink-0 whitespace-nowrap py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-10",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{item.tabLabel}</span>
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground"
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 py-2 sm:py-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-2 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={togglePlay}
          >
            {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            <span>{playing ? "Pause" : "Play"}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-2 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={replay}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            <span>Replay</span>
          </Button>
        </div>
      </div>

      {/* Plain-English story beat */}
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-muted-foreground">
          Step {activeIndex + 1}/{stages.length}
        </span>
        <span className="font-medium text-foreground text-pretty">{headline}</span>
      </div>

      {/* Two authentic product windows + animated signal bridge */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_116px_minmax(0,1fr)] sm:items-stretch sm:gap-0">
        {/* LEFT WINDOW: Authentic External Platform UI */}
        <TriggerExternalSurface
          provider={provider}
          stage={stage}
          isWritebackTarget={!isToAlook}
        />

        {/* CENTER LIVE ANIMATED BRIDGE */}
        <div
          aria-label={isToAlook ? `Trigger from ${meta.label} to Alook` : `Writeback from Alook to ${meta.label}`}
          className="flex items-center justify-center sm:flex-col sm:px-2"
        >
          {/* Desktop horizontal bridge with explicit directional arrowhead */}
          <div className="hidden w-full flex-col items-center gap-2 sm:flex">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap",
                isToAlook
                  ? "bg-[#ddf4ff] text-[#0969da] dark:bg-[#1f6feb]/25 dark:text-[#79c0ff]"
                  : "bg-[#f3e8ff] text-[#8250df] dark:bg-[#8957e5]/25 dark:text-[#d2a8ff]",
              )}
            >
              {isToAlook ? (
                <>
                  <span>Trigger</span>
                  <ArrowRight className="size-3 shrink-0" aria-hidden />
                </>
              ) : (
                <>
                  <ArrowLeft className="size-3 shrink-0" aria-hidden />
                  <span>Writeback</span>
                </>
              )}
            </span>

            <div className="relative flex h-5 w-full items-center">
              <div
                className={cn(
                  "h-0.5 w-full rounded-full",
                  isToAlook
                    ? "bg-[#5f8bcf]/45 dark:bg-[#7d97ff]/45"
                    : "bg-[#8250df]/45 dark:bg-[#a371f7]/45",
                )}
              />
              {isToAlook ? (
                <ArrowRight
                  className="absolute -right-1 size-3.5 text-[#34588f] dark:text-[#7d97ff]"
                  aria-hidden
                />
              ) : (
                <ArrowLeft
                  className="absolute -left-1 size-3.5 text-[#8250df] dark:text-[#d2a8ff]"
                  aria-hidden
                />
              )}
              {!reducedMotion ? (
                <motion.span
                  key={`${stage.id}-pulse-h`}
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full",
                    isToAlook
                      ? "bg-[#34588f] ring-4 ring-[#5f8bcf]/25 dark:bg-[#7d97ff] dark:ring-[#7d97ff]/25"
                      : "bg-[#8250df] ring-4 ring-[#8250df]/25 dark:bg-[#d2a8ff] dark:ring-[#d2a8ff]/25",
                  )}
                  initial={{ left: isToAlook ? "6%" : "82%" }}
                  animate={{ left: isToAlook ? "82%" : "6%" }}
                  transition={{
                    duration: 1.4,
                    ease: "easeInOut",
                    repeat: Infinity,
                    repeatDelay: 0.35,
                  }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                    isToAlook ? "bg-[#34588f] dark:bg-[#7d97ff]" : "bg-[#8250df] dark:bg-[#d2a8ff]",
                  )}
                />
              )}
            </div>

            <span className="max-w-full truncate text-center font-mono text-[10px] leading-tight text-muted-foreground">
              {bridgeTag}
            </span>
          </div>

          {/* Mobile vertical bridge */}
          <div className="flex w-full items-center justify-center gap-3 py-1 sm:hidden">
            <div className="relative flex h-8 w-5 justify-center">
              <div
                className={cn(
                  "h-full w-0.5 rounded-full",
                  isToAlook ? "bg-[#5f8bcf]/45" : "bg-[#8250df]/45",
                )}
              />
              {!reducedMotion ? (
                <motion.span
                  key={`${stage.id}-pulse-v`}
                  aria-hidden="true"
                  className={cn(
                    "absolute left-1/2 size-2 -translate-x-1/2 rounded-full",
                    isToAlook
                      ? "bg-[#34588f] ring-4 ring-[#5f8bcf]/25 dark:bg-[#7d97ff]"
                      : "bg-[#8250df] ring-4 ring-[#8250df]/25 dark:bg-[#d2a8ff]",
                  )}
                  initial={{ top: isToAlook ? "6%" : "74%" }}
                  animate={{ top: isToAlook ? "74%" : "6%" }}
                  transition={{
                    duration: 1.4,
                    ease: "easeInOut",
                    repeat: Infinity,
                    repeatDelay: 0.35,
                  }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#34588f]"
                />
              )}
            </div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap",
                isToAlook
                  ? "bg-[#ddf4ff] text-[#0969da] dark:bg-[#1f6feb]/25 dark:text-[#79c0ff]"
                  : "bg-[#f3e8ff] text-[#8250df] dark:bg-[#8957e5]/25 dark:text-[#d2a8ff]",
              )}
            >
              {isToAlook ? (
                <>
                  <ArrowDown className="size-3 shrink-0" aria-hidden />
                  <span>Trigger to Alook</span>
                </>
              ) : (
                <>
                  <ArrowUp className="size-3 shrink-0" aria-hidden />
                  <span>Writeback to {meta.label}</span>
                </>
              )}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">{bridgeTag}</span>
          </div>
        </div>

        {/* RIGHT WINDOW: Authentic Alook Desktop Shell UI */}
        <section
          aria-label="Alook workspace"
          className={cn(
            "grid min-w-0 grid-cols-[44px_minmax(0,1fr)] overflow-hidden rounded-xl border bg-white text-[#171717] transition-colors dark:bg-[#111214] dark:text-[#f2f3f5]",
            isToAlook
              ? "border-[#5f8bcf]/80 dark:border-[#7d97ff]/70"
              : "border-border",
          )}
        >
          {/* Real Alook Left Server Rail */}
          <div
            aria-hidden="true"
            className="flex flex-col items-center gap-2 border-r border-[#ebebeb] bg-[#fafafa] py-2.5 dark:border-[#23252a] dark:bg-[#0c0d10]"
          >
            <AnimatedAlookLogo className="size-7 shrink-0" />
            <div className="w-5 border-t border-[#e5e5e5] dark:border-[#26282e]" />
            <div className="relative flex w-full justify-center">
              <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-[#171717] dark:bg-[#f2f3f5]" />
              <span className="grid size-7 place-items-center rounded-xl bg-[#171717] text-xs font-semibold text-white dark:bg-[#f2f3f5] dark:text-[#111214]">
                {serverInitial}
              </span>
            </div>
            <span className="grid size-7 place-items-center rounded-xl border border-dashed border-[#d4d4d4] text-[#737373] dark:border-[#32353d] dark:text-[#8e9297]">
              <Plus className="size-3.5" />
            </span>
            <div className="mt-auto flex flex-col items-center gap-1 pt-2">
              <span className="relative">
                <AgentAvatar name={botName} seed={botName.toLowerCase()} size={22} />
                <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-status-online ring-2 ring-[#fafafa] dark:ring-[#0c0d10]" />
              </span>
            </div>
          </div>

          {/* Real Alook Conversation Pane */}
          <div className="flex min-w-0 flex-col">
            {/* Alook Channel / Forum Header */}
            <div className="flex items-center justify-between gap-2 border-b border-[#ebebeb] px-3 py-2 dark:border-[#23252a]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-[#f4f4f5] font-mono text-xs text-[#737373] dark:bg-[#1e2025] dark:text-[#9ca3af]">
                  /
                </span>
                <span className="truncate text-xs font-semibold">{channel}</span>
              </div>
              <span className="shrink-0 font-(family-name:--font-caveat) text-base font-bold leading-none text-[#737373] dark:text-[#9ca3af]">
                Alook
              </span>
            </div>

            {/* Thread subject + Trigger wake pill */}
            <div className="flex items-center justify-between gap-2 border-b border-[#f0f0f0] bg-[#fafafa] px-3 py-1.5 text-[11px] dark:border-[#1e2025] dark:bg-[#15171c]">
              <span className="truncate font-medium text-[#525252] dark:text-[#c9cdd4]">
                {threadTitle}
              </span>
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap font-medium",
                  isToAlook
                    ? "text-[#34588f] dark:text-[#7d97ff]"
                    : "text-[#8250df] dark:text-[#d2a8ff]",
                )}
              >
                {isToAlook ? `Woken by ${meta.label}` : "Approved"}
              </span>
            </div>

            {/* Alook Message Rows (native Alook anatomy + .mention-highlight) */}
            <motion.div
              key={`${stage.id}-alook`}
              initial={reducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              className="flex flex-1 flex-col gap-3 px-3 py-3"
            >
              {stage.messages.map((msg, msgIdx) => (
                <div key={`${stage.id}-${msgIdx}`} className="flex items-start gap-2.5">
                  <AgentAvatar
                    name={msg.author}
                    seed={msg.author.toLowerCase()}
                    size={28}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-semibold leading-none">{msg.author}</span>
                      <span
                        className={cn(
                          "rounded px-1 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide",
                          msg.role === "human"
                            ? "bg-[#eef2ff] text-[#34588f] dark:bg-[#34588f]/30 dark:text-[#9db8ff]"
                            : "bg-[#f4f4f5] text-[#737373] dark:bg-[#23252a] dark:text-[#9ca3af]",
                        )}
                      >
                        {msg.role === "human" ? "YOU" : "BOT"}
                      </span>
                      {msg.meta ? (
                        <span className="text-[11px] text-[#737373] dark:text-[#8e9297]">{msg.meta}</span>
                      ) : null}
                      {msg.time ? (
                        <span className="ml-auto font-mono text-[10px] text-[#a3a3a3] dark:text-[#6b7280]">
                          {msg.time}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[13px] leading-snug text-[#262626] dark:text-[#e4e5e7] text-pretty">
                      {msg.mentions?.map((target) => (
                        <span
                          key={target}
                          className="mention-highlight mr-1 font-medium text-[#171717] dark:text-[#f2f3f5]"
                        >
                          @{target}
                        </span>
                      ))}
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))}
            </motion.div>

            {/* Real Alook Composer Shell */}
            <div className="mx-2.5 mb-2.5 flex items-center gap-2 rounded-lg border border-[#e5e5e5] bg-[#fafafa] px-2.5 py-1.5 text-xs text-[#737373] dark:border-[#26282e] dark:bg-[#17191e] dark:text-[#8e9297]">
              <Plus className="size-3.5 shrink-0" aria-hidden />
              <span className="flex-1 truncate">Message /{channel}</span>
              <Smile className="size-3.5 shrink-0" aria-hidden />
            </div>
          </div>
        </section>
      </div>
    </figure>
  );
}

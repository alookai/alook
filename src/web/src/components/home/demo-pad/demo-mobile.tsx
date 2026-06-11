"use client";

import { ArrowUp, Home, CalendarDays, CircleDot } from "lucide-react";
import { MessageBubble } from "@/components/chat-primitives/message-bubble";
import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { AvatarRenderer } from "@/components/avatar/avatar-parts";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";
import type { DashboardState, DashboardConfig } from "./demo-dashboard";

export function DemoMobile({ state, config, className }: { state: DashboardState; config: DashboardConfig; className?: string }) {
  const agent = config.agents.find(a => a.name.toLowerCase() === state.activeAgent) ?? config.agents[0];
  const visibleSteps = state.steps.slice(0, state.visibleCount);

  return (
    <div className={cn("flex flex-col h-full overflow-hidden dark", className)}>
      {/* Mobile top bar */}
      <div className="h-6 flex items-center px-1.5 shrink-0">
        <div className="flex items-center gap-0.5">
          <div className="shrink-0 [&>button]:pointer-events-none scale-[0.6] origin-center">
            <Logo size="sm" iconOnly />
          </div>
          <Home className="size-2.5 text-muted-foreground shrink-0" />
          <CalendarDays className="size-2.5 text-muted-foreground shrink-0" />
          <CircleDot className="size-2.5 text-muted-foreground shrink-0" />
        </div>
        <div className="flex-1 flex items-center gap-1 ml-1 overflow-hidden">
          {config.agents.map((a) => {
            const isActive = state.activeAgent === a.name.toLowerCase();
            return (
              <div
                key={a.name}
                className={cn(
                  "shrink-0 size-4 rounded-full overflow-hidden transition-all",
                  isActive && "shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]",
                )}
              >
                <AvatarRenderer config={a.config} size={16} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Main card — matches real mobile shell */}
      <div className="flex-1 min-h-0 mx-1.5 mb-1.5 rounded-xl bg-card/80 backdrop-blur-xl shadow-lg ring-1 ring-border/40 overflow-hidden flex flex-col">
        {/* Agent nav inside card */}
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border/40">
          <span className="size-1 rounded-full bg-green-500" />
          <span className="text-[9px] font-medium text-foreground">{agent.name}</span>
          <span className="text-[8px] text-muted-foreground">/ Chat</span>
        </div>

        {/* Chat */}
        <div className="flex-1 min-h-0 overflow-hidden px-2.5 py-2">
          <div className="flex flex-col h-full justify-end gap-2">
            {visibleSteps.map((step, i) => {
              const isAgent = step.type === "message";
              const prevIsAgent = i > 0 && visibleSteps[i - 1].type === "message";
              const nextIsAgent = i < visibleSteps.length - 1 && visibleSteps[i + 1]?.type === "message";

              let groupPosition: "solo" | "first" | "middle" | "last" = "solo";
              if (isAgent) {
                if (!prevIsAgent && nextIsAgent) groupPosition = "first";
                else if (prevIsAgent && nextIsAgent) groupPosition = "middle";
                else if (prevIsAgent && !nextIsAgent) groupPosition = "last";
              }

              const isGroupStart = !prevIsAgent || !isAgent;
              const spacing = i === 0 ? "" : isGroupStart ? "mt-2.5" : "mt-0.5";

              return (
                <div key={i} className={`animate-[fade-up_300ms_ease-out_both] ${spacing}`}>
                  {(step.type === "email-in" || step.type === "email-out") && (
                    <div className="rounded border border-border/60 bg-card/80 px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <span className="text-[8px] text-muted-foreground truncate flex-1">
                          {step.type === "email-in" ? "from " : "to "}
                          {step.address}
                        </span>
                        <span className="text-[7px] font-bold uppercase tracking-wider text-muted-foreground/60 px-0.5 border border-muted-foreground/30 rounded-sm">
                          {step.type === "email-in" ? "In" : "Sent"}
                        </span>
                      </div>
                      <div className="text-[9px] font-medium leading-tight mt-0.5 line-clamp-1">{step.subject}</div>
                    </div>
                  )}
                  {step.type === "user-message" && (
                    <div className="flex justify-end">
                      <MessageBubble variant="user" position="single" className="text-[9px]! leading-tight!">
                        {step.text}
                      </MessageBubble>
                    </div>
                  )}
                  {step.type === "message" && (
                    <div className="flex items-start gap-1">
                      {(groupPosition === "solo" || groupPosition === "first") ? (
                        <div className="size-4 rounded overflow-hidden shrink-0 mt-0.5">
                          <AnimatedAvatar config={agent.config} size={16} isHovered={false} isWorking={state.isWorking} />
                        </div>
                      ) : (
                        <div className="w-4 shrink-0" />
                      )}
                      <div className="min-w-0 flex flex-col">
                        {(groupPosition === "solo" || groupPosition === "first") && (
                          <span className="text-[8px] font-semibold text-foreground leading-none mb-0.5">{agent.name}</span>
                        )}
                        <MessageBubble variant="agent" position={groupPosition === "solo" ? "single" : groupPosition} className="text-[9px]! leading-tight!">
                          {step.markdown ? (
                            <div className="space-y-0.5" dangerouslySetInnerHTML={{ __html: step.markdown }} />
                          ) : (
                            step.text
                          )}
                        </MessageBubble>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Composer */}
        <div className="px-2 py-1.5 border-t border-border/40">
          {state.isTyping && (
            <div className="h-3 flex items-center mb-0.5">
              <span className="text-[8px] text-muted-foreground">{agent.name} is typing</span>
              <span className="inline-flex items-center gap-px ml-1">
                <span className="size-0.5 rounded-full bg-muted-foreground/60 animate-[typing-dot_1.2s_ease-in-out_infinite]" />
                <span className="size-0.5 rounded-full bg-muted-foreground/60 animate-[typing-dot_1.2s_ease-in-out_0.2s_infinite]" />
                <span className="size-0.5 rounded-full bg-muted-foreground/60 animate-[typing-dot_1.2s_ease-in-out_0.4s_infinite]" />
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2.5 py-1">
            <span className="flex-1 text-[8px] text-muted-foreground/50">Message...</span>
            <div className="size-3.5 rounded-full bg-primary flex items-center justify-center">
              <ArrowUp className="size-2 text-primary-foreground" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { ArrowUp, Home, CalendarDays, CircleDot } from "lucide-react";
import { MessageBubble } from "@/components/chat-primitives/message-bubble";
import { MessageCluster } from "@/components/chat-primitives/message-cluster";
import { PresenceLine } from "@/components/agent-chat/presence-line";
import { EmailCard } from "@/components/agent-chat/event-cards/email-card";
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
      {/* Mobile top bar — matches real MobileTopBar */}
      <div className="h-8 flex items-center gap-1.5 px-2 shrink-0">
        <div className="shrink-0 [&>button]:pointer-events-none">
          <Logo size="sm" iconOnly />
        </div>
        <div className="shrink-0 p-0.5 rounded text-muted-foreground">
          <Home className="size-3.5" />
        </div>
        <div className="shrink-0 p-0.5 rounded text-muted-foreground">
          <CalendarDays className="size-3.5" />
        </div>
        <div className="shrink-0 p-0.5 rounded text-muted-foreground">
          <CircleDot className="size-3.5" />
        </div>
        <div className="flex-1 flex items-center gap-1 px-0.5 overflow-hidden">
          {config.agents.map((a) => {
            const isActive = state.activeAgent === a.name.toLowerCase();
            return (
              <div
                key={a.name}
                className={cn(
                  "shrink-0 size-6 rounded-full overflow-hidden transition-all",
                  isActive && "ring-2 ring-primary",
                )}
              >
                <AvatarRenderer config={a.config} size={24} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Main card — matches real mobile shell */}
      <div className="flex-1 min-h-0 mx-1.5 mb-1.5 rounded-xl bg-card/80 backdrop-blur-xl shadow-lg ring-1 ring-border/40 overflow-hidden flex flex-col">
        {/* Agent nav inside card */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/40">
          <span className="size-1.5 rounded-full bg-green-500" />
          <span className="text-xs font-medium text-foreground">{agent.name}</span>
          <span className="text-[10px] text-muted-foreground">/ Chat</span>
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
                  {step.type === "email-in" && (
                    <EmailCard subject={step.subject!} address={step.address!} direction="inbound" />
                  )}
                  {step.type === "email-out" && (
                    <EmailCard subject={step.subject!} address={step.address!} direction="outbound" />
                  )}
                  {step.type === "user-message" && (
                    <div className="flex justify-end">
                      <MessageBubble variant="user" position="single">
                        <span className="text-xs">{step.text}</span>
                      </MessageBubble>
                    </div>
                  )}
                  {step.type === "message" && (
                    <MessageCluster
                      avatar={
                        <div className="size-5 rounded-md overflow-hidden">
                          <AnimatedAvatar config={agent.config} size={20} isHovered={false} isWorking={state.isWorking} />
                        </div>
                      }
                      name={agent.name}
                      position={groupPosition}
                    >
                      <MessageBubble variant="agent" position={groupPosition === "solo" ? "single" : groupPosition}>
                        {step.markdown ? (
                          <div className="text-xs space-y-1" dangerouslySetInnerHTML={{ __html: step.markdown }} />
                        ) : (
                          <span className="text-xs">{step.text}</span>
                        )}
                      </MessageBubble>
                    </MessageCluster>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Composer */}
        <div className="px-2.5 py-2 border-t border-border/40">
          {state.isTyping && (
            <PresenceLine agentFirstName={agent.name} taskStatus="running" />
          )}
          <div className="flex items-center gap-2 rounded-full border border-border/60 bg-muted/20 px-3 py-1.5">
            <span className="flex-1 text-xs text-muted-foreground/50">Message...</span>
            <div className="size-5 rounded-full bg-primary flex items-center justify-center">
              <ArrowUp className="size-3 text-primary-foreground" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

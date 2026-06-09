"use client";

import { ArrowUp, Home, Mail, MessageSquare } from "lucide-react";
import { MessageBubble } from "@/components/chat-primitives/message-bubble";
import { MessageCluster } from "@/components/chat-primitives/message-cluster";
import { PresenceLine } from "@/components/agent-chat/presence-line";
import { EmailCard } from "@/components/agent-chat/event-cards/email-card";
import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { AvatarRenderer, type AvatarConfig } from "@/components/avatar/avatar-parts";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

const PLANNER_CONFIG: AvatarConfig = { shape: "hexagon", eye: "dots", nose: "dash", bg: 5 };
const CODER_CONFIG: AvatarConfig = { shape: "task", eye: "happy", nose: "dot", bg: 0 };
const REVIEWER_CONFIG: AvatarConfig = { shape: "circle", eye: "arches", nose: "smile", bg: 8 };

export interface DashboardStep {
  type: "email-in" | "email-out" | "message" | "user-message";
  subject?: string;
  address?: string;
  text?: string;
  markdown?: string;
}

export interface DashboardState {
  activeAgent: "planner" | "coder";
  steps: DashboardStep[];
  visibleCount: number;
  isTyping: boolean;
  isWorking: boolean;
}

const AGENT_INFO = {
  planner: { name: "Planner", email: "planner@alook.ai", config: PLANNER_CONFIG },
  coder: { name: "Coder", email: "coder@alook.ai", config: CODER_CONFIG },
} as const;

export function DemoDashboard({ state, className }: { state: DashboardState; className?: string }) {
  const agent = AGENT_INFO[state.activeAgent];
  const visibleSteps = state.steps.slice(0, state.visibleCount);

  return (
    <div className={cn("flex h-full overflow-hidden", className)}>
      {/* Sidebar */}
      <div className="flex h-full w-11 flex-col items-center py-2 gap-1 border-r border-border/40 shrink-0">
        <div className="mb-1.5">
          <Logo size="sm" iconOnly />
        </div>
        <div className="flex flex-col items-center gap-1 mb-1 pb-1.5 border-b border-border/30">
          <div className="flex items-center justify-center size-7 rounded-lg text-muted-foreground/50">
            <Home className="size-3" />
          </div>
          <div className="flex items-center justify-center size-7 rounded-lg text-muted-foreground/50">
            <Mail className="size-3" />
          </div>
        </div>
        <div className="flex flex-col items-center gap-1.5 flex-1">
          <div className={cn(
            "size-7 rounded-lg overflow-hidden ring-1 transition-all duration-300",
            state.activeAgent === "planner" ? "ring-primary/60 shadow-sm" : "ring-transparent",
          )}>
            <AvatarRenderer config={PLANNER_CONFIG} size={28} />
          </div>
          <div className={cn(
            "size-7 rounded-lg overflow-hidden ring-1 transition-all duration-300",
            state.activeAgent === "coder" ? "ring-primary/60 shadow-sm" : "ring-transparent",
          )}>
            <AvatarRenderer config={CODER_CONFIG} size={28} />
          </div>
          <div className="size-7 rounded-lg overflow-hidden ring-1 ring-transparent">
            <AvatarRenderer config={REVIEWER_CONFIG} size={28} />
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Navbar */}
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="size-1.5 rounded-full bg-green-500" />
            <span className="text-[11px] font-medium text-foreground">{agent.name}</span>
            <span className="text-[10px] text-muted-foreground/60">/ Chat</span>
          </div>
          <div className="flex items-center gap-0.5">
            <span className="inline-flex items-center rounded text-[10px] h-4 px-1 text-foreground bg-muted/60">
              <MessageSquare className="size-2.5 mr-0.5" />
              Chat
            </span>
            <span className="inline-flex items-center rounded text-[10px] h-4 px-1 text-muted-foreground/60">
              <Mail className="size-2.5 mr-0.5" />
              Email
            </span>
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 min-h-0 overflow-hidden px-3 py-3">
          <div className="flex flex-col h-full justify-end">
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
              const spacing = i === 0 ? "" : isGroupStart ? "mt-4" : "mt-0.5";

              return (
                <div key={i} className={`animate-[fade-up_300ms_ease-out_both] ${spacing}`}>
                  {step.type === "email-in" && (
                    <MessageCluster
                      avatar={
                        <div className="size-[26px] rounded-lg overflow-hidden">
                          <AnimatedAvatar config={agent.config} size={26} isHovered={false} isWorking={state.isWorking} />
                        </div>
                      }
                      name={agent.name}
                      position="solo"
                    >
                      <EmailCard subject={step.subject!} address={step.address!} direction="inbound" />
                    </MessageCluster>
                  )}
                  {step.type === "email-out" && (
                    <MessageCluster
                      avatar={
                        <div className="size-[26px] rounded-lg overflow-hidden">
                          <AnimatedAvatar config={agent.config} size={26} isHovered={false} isWorking={false} />
                        </div>
                      }
                      name={agent.name}
                      position="solo"
                    >
                      <EmailCard subject={step.subject!} address={step.address!} direction="outbound" />
                    </MessageCluster>
                  )}
                  {step.type === "user-message" && (
                    <div className="flex justify-end">
                      <MessageBubble variant="user" position="single">
                        <span className="text-[13px]">{step.text}</span>
                      </MessageBubble>
                    </div>
                  )}
                  {step.type === "message" && (
                    <MessageCluster
                      avatar={
                        <div className="size-[26px] rounded-lg overflow-hidden">
                          <AnimatedAvatar config={agent.config} size={26} isHovered={false} isWorking={state.isWorking} />
                        </div>
                      }
                      name={agent.name}
                      position={groupPosition}
                    >
                      <MessageBubble variant="agent" position={groupPosition === "solo" ? "single" : groupPosition}>
                        {step.markdown ? (
                          <div className="text-[13px] space-y-1" dangerouslySetInnerHTML={{ __html: step.markdown }} />
                        ) : (
                          <span className="text-[13px]">{step.text}</span>
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
        <div className="px-3 py-2 border-t border-border/40">
          {state.isTyping && (
            <PresenceLine agentFirstName={agent.name} taskStatus="running" />
          )}
          <div className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
            <span className="flex-1 text-[11px] text-muted-foreground/50">Message {agent.name}...</span>
            <div className="size-4 rounded-full bg-primary/15 flex items-center justify-center">
              <ArrowUp className="size-2.5 text-primary/50" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

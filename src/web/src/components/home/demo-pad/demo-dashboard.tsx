"use client";

import { ArrowUp, FileText, Home, Mail, MessageSquare } from "lucide-react";
import { MessageBubble } from "@/components/chat-primitives/message-bubble";
import { MessageCluster } from "@/components/chat-primitives/message-cluster";
import { PresenceLine } from "@/components/agent-chat/presence-line";
import { EmailCard } from "@/components/agent-chat/event-cards/email-card";
import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { AvatarRenderer, type AvatarConfig } from "@/components/avatar/avatar-parts";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

export interface AgentInfo {
  name: string;
  email: string;
  config: AvatarConfig;
}

export interface DashboardStep {
  type: "email-in" | "email-out" | "message" | "user-message";
  subject?: string;
  address?: string;
  text?: string;
  markdown?: string;
  attachment?: string;
}

export interface DashboardState {
  activeAgent: string;
  steps: DashboardStep[];
  visibleCount: number;
  isTyping: boolean;
  isWorking: boolean;
}

export interface DashboardConfig {
  agents: AgentInfo[];
}

export function DemoDashboard({ state, config, className }: { state: DashboardState; config: DashboardConfig; className?: string }) {
  const agent = config.agents.find(a => a.name.toLowerCase() === state.activeAgent) ?? config.agents[0];
  const visibleSteps = state.steps.slice(0, state.visibleCount);

  return (
    <div className={cn("flex h-full overflow-hidden dark", className)}>
      {/* Sidebar */}
      <div className="flex h-full w-11 flex-col items-center py-2 gap-1 border-r border-border/40 shrink-0">
        <div className="mb-2">
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
        <div className="flex flex-col items-center gap-2 flex-1">
          {config.agents.map((a) => {
            const isActive = state.activeAgent === a.name.toLowerCase();
            return (
              <div
                key={a.name}
                className={cn(
                  "size-8 rounded-xl overflow-hidden ring-2 transition-all duration-300",
                  isActive
                    ? "ring-primary/50 shadow-md shadow-primary/20 scale-105"
                    : "ring-transparent hover:ring-border/60",
                )}
              >
                <AvatarRenderer config={a.config} size={32} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Navbar — matches real product agent layout */}
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="size-2 rounded-full bg-green-500" />
            <span className="text-sm font-medium text-foreground">{agent.name}</span>
            <span className="text-xs text-muted-foreground">/ Chat</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="inline-flex items-center rounded-lg text-xs h-6 px-2 text-foreground bg-muted">
              <MessageSquare className="size-3 mr-1" />
              Chat
            </span>
            <span className="inline-flex items-center rounded-lg text-xs h-6 px-2 text-muted-foreground hover:bg-muted">
              <Mail className="size-3 mr-1" />
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
              const spacing = i === 0 ? "" : isGroupStart ? "mt-4" : "mt-1";

              return (
                <div key={i} className={`animate-[fade-up_300ms_ease-out_both] ${spacing}`}>
                  {step.type === "email-in" && (
                    <MessageCluster
                      avatar={
                        <div className="size-6.5 rounded-lg overflow-hidden">
                          <AnimatedAvatar config={agent.config} size={26} isHovered={false} isWorking={state.isWorking} />
                        </div>
                      }
                      name={agent.name}
                      position="solo"
                    >
                      <div className="text-neutral-100">
                        <EmailCard subject={step.subject!} address={step.address!} direction="inbound" />
                      </div>
                    </MessageCluster>
                  )}
                  {step.type === "email-out" && (
                    <MessageCluster
                      avatar={
                        <div className="size-6.5 rounded-lg overflow-hidden">
                          <AnimatedAvatar config={agent.config} size={26} isHovered={false} isWorking={false} />
                        </div>
                      }
                      name={agent.name}
                      position="solo"
                    >
                      <div className="text-neutral-100">
                        <EmailCard subject={step.subject!} address={step.address!} direction="outbound" />
                      </div>
                    </MessageCluster>
                  )}
                  {step.type === "user-message" && (
                    <div className="flex justify-end">
                      <MessageBubble variant="user" position="single">
                        <span className="text-sm">{step.text}</span>
                        {step.attachment && (
                          <div className="flex items-center gap-1 mt-2 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-1">
                            <FileText className="size-3 shrink-0" />
                            <span className="text-xs opacity-80">{step.attachment}</span>
                          </div>
                        )}
                      </MessageBubble>
                    </div>
                  )}
                  {step.type === "message" && (
                    <MessageCluster
                      avatar={
                        <div className="size-6.5 rounded-lg overflow-hidden">
                          <AnimatedAvatar config={agent.config} size={26} isHovered={false} isWorking={state.isWorking} />
                        </div>
                      }
                      name={agent.name}
                      position={groupPosition}
                    >
                      <MessageBubble variant="agent" position={groupPosition === "solo" ? "single" : groupPosition}>
                        {step.markdown ? (
                          <div className="text-sm space-y-1" dangerouslySetInnerHTML={{ __html: step.markdown }} />
                        ) : (
                          <span className="text-sm">{step.text}</span>
                        )}
                      </MessageBubble>
                    </MessageCluster>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Composer — matches real product pill shape */}
        <div className="px-3 py-3 border-t border-border/40">
          {state.isTyping && (
            <PresenceLine agentFirstName={agent.name} taskStatus="running" />
          )}
          <div className="flex items-center gap-2 rounded-3xl border border-border/60 bg-muted/20 px-4 py-2">
            <span className="flex-1 text-sm text-muted-foreground/50">Message {agent.name}...</span>
            <div className="size-6 rounded-full bg-primary flex items-center justify-center">
              <ArrowUp className="size-3.5 text-primary-foreground" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

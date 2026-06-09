"use client";

import { useMemo } from "react";
import { DemoDashboard, type DashboardStep, type DashboardState } from "./demo-dashboard";
import { useScriptedTimeline, type TimelineStep } from "./use-scripted-timeline";

export interface AgentPhase {
  agent: "planner" | "coder";
  steps: DashboardStep[];
}

export interface UseCaseScript {
  phases: AgentPhase[];
  timeline: TimelineStep[];
  /** Maps timeline step index → { phaseIndex, visibleCount, isTyping } */
  derive: (isStepVisible: (i: number) => boolean) => DashboardState;
}

export function UseCaseDemo({ script }: { script: UseCaseScript }) {
  const { visibleCount, isResetting, containerRef, isStepVisible } =
    useScriptedTimeline({ steps: script.timeline, holdAfterComplete: 3000 });

  const state = useMemo(
    () => script.derive(isStepVisible),
    [visibleCount], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div
      ref={containerRef}
      className={`h-full transition-opacity duration-300 ${isResetting ? "opacity-0" : "opacity-100"}`}
    >
      <DemoDashboard state={state} />
    </div>
  );
}

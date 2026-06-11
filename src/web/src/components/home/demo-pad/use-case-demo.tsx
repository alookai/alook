"use client";

import { useMemo } from "react";
import { DemoDashboard, type DashboardState, type DashboardConfig, type AgentInfo } from "./demo-dashboard";
import { useScriptedTimeline, type TimelineStep } from "./use-scripted-timeline";

export interface UseCaseScript {
  agents: AgentInfo[];
  timeline: TimelineStep[];
  derive: (isStepVisible: (i: number) => boolean) => DashboardState;
}

export function UseCaseDemo({ script }: { script: UseCaseScript }) {
  const { visibleCount, isResetting, containerRef, isStepVisible } =
    useScriptedTimeline({ steps: script.timeline, holdAfterComplete: 3000 });

  const state = useMemo(
    () => script.derive(isStepVisible),
    [visibleCount], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const config: DashboardConfig = useMemo(() => ({ agents: script.agents }), [script.agents]);

  return (
    <div
      ref={containerRef}
      className={`h-full transition-opacity duration-300 ${isResetting ? "opacity-0" : "opacity-100"}`}
    >
      <DemoDashboard state={state} config={config} />
    </div>
  );
}

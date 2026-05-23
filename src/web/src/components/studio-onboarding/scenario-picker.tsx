"use client";

import { cn } from "@/lib/utils";
import { SCENARIO_PRESETS, type ScenarioId } from "./scenario-presets";

export function ScenarioPicker({
  selected,
  onSelect,
  onBrowseTemplates,
}: {
  selected: ScenarioId | null;
  onSelect: (id: ScenarioId) => void;
  onBrowseTemplates?: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight">What will your company focus on?</h2>
        {onBrowseTemplates && (
          <button
            type="button"
            onClick={onBrowseTemplates}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
          >
            Browse templates <span aria-hidden="true">&rsaquo;</span>
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SCENARIO_PRESETS.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-all hover:border-foreground/30",
              selected === s.id
                ? "border-foreground/50 bg-muted/50"
                : "border-border",
            )}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-lg">{s.icon}</span>
              <span className="text-[10px] text-muted-foreground/70">
                {s.members.length} agent{s.members.length > 1 ? "s" : ""}
              </span>
            </div>
            <span className="text-sm font-medium">{s.label}</span>
            <span className="text-xs text-muted-foreground leading-tight">
              {s.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

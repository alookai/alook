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
        <h2 className="text-sm font-medium">What will your studio focus on?</h2>
        {onBrowseTemplates && (
          <button
            type="button"
            onClick={onBrowseTemplates}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
          >
            Browse templates
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SCENARIO_PRESETS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-all hover:border-foreground/30",
              selected === s.id
                ? "border-foreground/50 bg-muted/50"
                : "border-border",
              i === SCENARIO_PRESETS.length - 1 && SCENARIO_PRESETS.length % 2 !== 0 && "sm:col-span-2",
            )}
          >
            <span className="text-lg">{s.icon}</span>
            <span className="text-sm font-medium">{s.label}</span>
            <span className="text-xs text-muted-foreground leading-tight">
              {s.description}
            </span>
            <span className="text-[10px] text-muted-foreground/70 mt-1">
              {s.members.length} teammate{s.members.length > 1 ? "s" : ""}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import {
  CLOUD_CODE_MONSTER_PET_PRESETS,
  getCloudCodeMonsterPreset,
  readCloudCodeMonsterPetPresetId,
  writeCloudCodeMonsterPetPresetId,
} from "@/components/home-pet/cloud-code-monster-pet-presets";
import { CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT } from "@/components/home-pet/cloud-code-monster-pet-constants";
import { CloudCodeMonsterPresetPreview } from "@/components/home-pet/cloud-code-monster-pet-pixel-parts";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  readHomePetSettings,
  writeHomePetSettings,
} from "@/lib/home-pet-settings";
import { cn } from "@/lib/utils";

export function PetTab() {
  const [enabled, setEnabled] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState(
    CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id
  );
  const selectedPreset = getCloudCodeMonsterPreset(selectedPresetId);

  useEffect(() => {
    const settings = readHomePetSettings();
    setEnabled(settings.enabled);
    setSelectedPresetId(readCloudCodeMonsterPetPresetId());

    const handlePresetChange = (event: Event) => {
      const nextPresetId = (event as CustomEvent<{ presetId?: string }>).detail
        ?.presetId;
      setSelectedPresetId(
        nextPresetId
          ? getCloudCodeMonsterPreset(nextPresetId).id
          : readCloudCodeMonsterPetPresetId()
      );
    };

    window.addEventListener(
      CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
      handlePresetChange
    );

    return () => {
      window.removeEventListener(
        CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
        handlePresetChange
      );
    };
  }, []);

  const handleEnabledChange = (checked: boolean) => {
    setEnabled(checked);
    writeHomePetSettings({ enabled: checked });
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-medium">Pet</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="pet-enabled" className="text-sm">
                Enable pet
              </Label>
              <p className="text-xs text-muted-foreground">
                Off by default. Turn it on when you want the workspace companion.
              </p>
            </div>
            <Switch
              id="pet-enabled"
              checked={enabled}
              onCheckedChange={handleEnabledChange}
            />
          </div>
        </div>
      </section>

      {enabled ? (
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Preset</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedPreset.name}
              </p>
            </div>
            <div className="grid size-14 place-items-center rounded-md bg-card ring-1 ring-border/60">
              <CloudCodeMonsterPresetPreview
                preset={selectedPreset}
                className="size-11"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CLOUD_CODE_MONSTER_PET_PRESETS.map((preset) => {
              const isSelected = preset.id === selectedPreset.id;

              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    const nextPresetId = writeCloudCodeMonsterPetPresetId(
                      preset.id
                    );
                    setSelectedPresetId(nextPresetId);
                  }}
                  className={cn(
                    "group grid h-28 min-w-0 grid-rows-[1fr_auto] rounded-md border bg-card/60 p-2 text-left transition-all hover:border-foreground/20 hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                    isSelected
                      ? "border-primary/50 bg-accent text-foreground"
                      : "border-border/50 text-muted-foreground"
                  )}
                >
                  <div className="grid place-items-center rounded bg-background/70 ring-1 ring-border/35">
                    <CloudCodeMonsterPresetPreview
                      preset={preset}
                      className="size-14 transition-transform duration-200 group-hover:scale-105"
                    />
                  </div>
                  <div className="mt-2 flex min-w-0 items-center justify-between gap-1 text-[10px] leading-none">
                    <span className="truncate font-medium text-foreground">
                      {preset.name}
                    </span>
                    {isSelected ? (
                      <Sparkles className="size-3 shrink-0 text-primary" />
                    ) : (
                      <span className="shrink-0 text-muted-foreground">
                        {preset.id.replace("pet-", "#")}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

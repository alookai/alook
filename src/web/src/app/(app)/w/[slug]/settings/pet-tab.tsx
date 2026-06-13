"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import {
  CLOUD_CODE_MONSTER_PET_PRESETS,
  getCloudCodeMonsterPreset,
  readCloudCodeMonsterPetPresetId,
  writeCloudCodeMonsterPetPresetId,
} from "@/components/home-pet/cloud-code-monster-pet-presets";
import { CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT } from "@/components/home-pet/cloud-code-monster-pet-constants";
import {
  CloudCodeMonsterPresetPreview,
  resolveCloudCodeMonsterPreviewEyeOffset,
} from "@/components/home-pet/cloud-code-monster-pet-pixel-parts";
import type { PetPoint } from "@/components/home-pet/cloud-code-monster-pet-types";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  readHomePetSettings,
  writeHomePetSettings,
} from "@/lib/home-pet-settings";
import { cn } from "@/lib/utils";

const EMPTY_PREVIEW_EYE_OFFSET: PetPoint = { x: 0, y: 0 };
const PET_PREVIEW_EYE_TRACKER_SELECTOR =
  "[data-pet-preview-eye-tracker][data-pet-preview-preset-id]";

function arePreviewEyeOffsetsEqual(
  currentEyeOffsets: Record<string, PetPoint>,
  nextEyeOffsets: Record<string, PetPoint>
) {
  const currentKeys = Object.keys(currentEyeOffsets);
  const nextKeys = Object.keys(nextEyeOffsets);
  if (currentKeys.length !== nextKeys.length) return false;

  return nextKeys.every((key) => {
    const currentEyeOffset = currentEyeOffsets[key];
    const nextEyeOffset = nextEyeOffsets[key]!;
    return (
      currentEyeOffset?.x === nextEyeOffset.x &&
      currentEyeOffset.y === nextEyeOffset.y
    );
  });
}

export function PetTab() {
  const petTabRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState(
    CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id
  );
  const [previewEyeOffsets, setPreviewEyeOffsets] = useState<
    Record<string, PetPoint>
  >({});
  const selectedPreset = getCloudCodeMonsterPreset(selectedPresetId);

  const resetPreviewEyeOffsets = useCallback(() => {
    setPreviewEyeOffsets((currentEyeOffsets) => {
      if (Object.keys(currentEyeOffsets).length === 0) {
        return currentEyeOffsets;
      }

      return {};
    });
  }, []);

  const handlePagePointerMove = useCallback((event: globalThis.PointerEvent) => {
    const root = petTabRef.current;
    if (!root) return;

    const nextEyeOffsets: Record<string, PetPoint> = {};
    const pointer = { x: event.clientX, y: event.clientY };

    root
      .querySelectorAll<HTMLElement>(PET_PREVIEW_EYE_TRACKER_SELECTOR)
      .forEach((element) => {
        const previewId = element.dataset.petPreviewEyeTracker;
        const presetId = element.dataset.petPreviewPresetId;
        if (!previewId || !presetId) return;

        nextEyeOffsets[previewId] = resolveCloudCodeMonsterPreviewEyeOffset(
          pointer,
          element.getBoundingClientRect(),
          getCloudCodeMonsterPreset(presetId)
        );
      });

    setPreviewEyeOffsets((currentEyeOffsets) =>
      arePreviewEyeOffsetsEqual(currentEyeOffsets, nextEyeOffsets)
        ? currentEyeOffsets
        : nextEyeOffsets
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      resetPreviewEyeOffsets();
      return;
    }

    window.addEventListener("pointermove", handlePagePointerMove, {
      passive: true,
    });
    window.addEventListener("blur", resetPreviewEyeOffsets);

    return () => {
      window.removeEventListener("pointermove", handlePagePointerMove);
      window.removeEventListener("blur", resetPreviewEyeOffsets);
    };
  }, [enabled, handlePagePointerMove, resetPreviewEyeOffsets]);

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
    <div ref={petTabRef} className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-medium">Pet</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
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
          <div>
            <h2 className="text-sm font-medium">Preset</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {selectedPreset.name}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CLOUD_CODE_MONSTER_PET_PRESETS.map((preset) => {
              const isSelected = preset.id === selectedPreset.id;

              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${preset.name} preset${
                    isSelected ? ", selected" : ""
                  }`}
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
                  <div
                    data-pet-preview-eye-tracker={
                      isSelected ? undefined : preset.id
                    }
                    data-pet-preview-preset-id={
                      isSelected ? undefined : preset.id
                    }
                    className="grid place-items-center rounded bg-background/70 ring-1 ring-border/35"
                  >
                    {isSelected ? (
                      <span
                        data-pet-selected-note=""
                        aria-hidden="true"
                        className="pointer-events-none relative grid h-10 w-16 max-w-full -rotate-3 place-items-center rounded-lg border border-border/70 bg-card/95 px-1.5 text-center shadow-sm"
                      >
                        <span className="absolute -top-1 h-2 w-6 rounded-xs bg-primary/15 ring-1 ring-primary/10" />
                        <span className="absolute right-1.5 top-1.5 size-1 rounded-full bg-primary/25" />
                        <span className="absolute bottom-1.5 left-2 h-px w-8 bg-border/50" />
                        <span className="relative max-w-full text-[9px] font-medium leading-[1.05] text-muted-foreground">
                          Out for work
                        </span>
                      </span>
                    ) : (
                      <CloudCodeMonsterPresetPreview
                        preset={preset}
                        eyeOffset={
                          previewEyeOffsets[preset.id] ??
                          EMPTY_PREVIEW_EYE_OFFSET
                        }
                        className="size-14 transition-transform duration-200 group-hover:scale-105"
                      />
                    )}
                  </div>
                  <div className="mt-1.5 flex min-w-0 items-center justify-between gap-1 text-[10px] leading-none">
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

"use client";

import { type RefObject } from "react";
import dynamic from "next/dynamic";

import { useHomePetSettings } from "@/lib/home-pet-settings";
import type { CloudCodeMonsterPetProps } from "./cloud-code-monster-pet";

const CloudCodeMonsterPet = dynamic<CloudCodeMonsterPetProps>(
  () =>
    import("./cloud-code-monster-pet").then(
      (module) => module.CloudCodeMonsterPet
    ),
  { ssr: false }
);

type WorkspacePetLayerProps = {
  boundaryRef: RefObject<HTMLElement | null>;
  slug: string;
};

export function WorkspacePetLayer({ boundaryRef, slug }: WorkspacePetLayerProps) {
  const petSettings = useHomePetSettings();

  if (!petSettings.enabled) {
    return null;
  }

  return (
    <CloudCodeMonsterPet
      boundaryRef={boundaryRef}
      positionStorageKey={`alook-cloud-code-monster-pet-position-${slug}`}
    />
  );
}

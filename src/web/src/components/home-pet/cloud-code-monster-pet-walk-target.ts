"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { type RefObject, useCallback, useEffect, useRef } from "react";

import { clampPetPosition, createWalkToTargetVelocity, getBounds } from "./cloud-code-monster-pet-activity";
import { CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS, CLOUD_CODE_MONSTER_SIZE } from "./cloud-code-monster-pet-constants";
import type { PetPoint } from "./cloud-code-monster-pet-types";

const WALK_TO_TARGET_SPEED = 3.2;
const ARRIVAL_THRESHOLD = 10;
const TARGET_OFFSET_X = 22;

export type WalkToTargetState = {
  isWalking: boolean;
  isIdlingAtTarget: boolean;
  walkDirection: "left" | "right";
};

type UseWalkToTargetParams = {
  boundaryRef: RefObject<HTMLElement | null>;
  targetId: string | null;
  enabled: boolean;
  position: PetPoint | null;
  setPosition: (updater: (pos: PetPoint | null) => PetPoint | null) => void;
  onArrive: () => void;
  onStep: (position: PetPoint, intensity: number) => void;
};

function getTargetPosition(
  boundaryEl: HTMLElement | null,
  targetId: string
): PetPoint | null {
  if (!boundaryEl) return null;

  const targetEl =
    boundaryEl.querySelector<HTMLElement>(`[data-pet-target-id="${targetId}"]`) ??
    document.querySelector<HTMLElement>(`[data-pet-target-id="${targetId}"]`);
  if (!targetEl) return null;

  const targetRect = targetEl.getBoundingClientRect();
  const bounds = getBounds(boundaryEl);

  const x = targetRect.right + TARGET_OFFSET_X;
  const y = targetRect.top + targetRect.height / 2 - CLOUD_CODE_MONSTER_SIZE.height / 2;

  return clampPetPosition({ x, y }, bounds, CLOUD_CODE_MONSTER_SIZE);
}

export function useWalkToTarget({
  boundaryRef,
  targetId,
  enabled,
  position,
  setPosition,
  onArrive,
  onStep,
}: UseWalkToTargetParams): WalkToTargetState {
  const [isWalking, setIsWalking] = useAtom(useCreateAtom(false));
  const [isIdlingAtTarget, setIsIdlingAtTarget] = useAtom(useCreateAtom(false));
const [walkDirection, setWalkDirection] = useAtom(useCreateAtom<"left" | "right">("left"));
  const stepTimerRef = useRef<number | null>(null);
  const arrivedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const positionRef = useRef(position);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { positionRef.current = position; }, [position]);

  const clearStepTimer = useCallback(() => {
    if (stepTimerRef.current !== null) {
      window.clearTimeout(stepTimerRef.current);
      stepTimerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    clearStepTimer();
    setIsWalking(false);
    setIsIdlingAtTarget(false);
    arrivedRef.current = false;
  }, [clearStepTimer, setIsIdlingAtTarget, setIsWalking]);

  useEffect(() => {
    if (!enabled || !targetId || !position) {
      cancel();
      return;
    }

    if (arrivedRef.current) {
      return;
    }

    setIsWalking(true);
    setIsIdlingAtTarget(false);

    const scheduleStep = () => {
      stepTimerRef.current = window.setTimeout(() => {
        stepTimerRef.current = null;

        if (!enabledRef.current) {
          setIsWalking(false);
          return;
        }

        const target = getTargetPosition(boundaryRef.current, targetId);
        const current = positionRef.current;

        if (!target || !current) {
          scheduleStep();
          return;
        }

        const dx = target.x - current.x;
        const dy = target.y - current.y;
        const distance = Math.hypot(dx, dy);

        if (distance < ARRIVAL_THRESHOLD) {
          arrivedRef.current = true;
          setIsWalking(false);
          setIsIdlingAtTarget(true);
          setWalkDirection("left");
          setPosition(() => target);
          onArrive();
          return;
        }

        const velocity = createWalkToTargetVelocity(current, target, WALK_TO_TARGET_SPEED);
        setWalkDirection(velocity.x >= 0 ? "right" : "left");

        const next = clampPetPosition(
          { x: current.x + velocity.x, y: current.y + velocity.y },
          getBounds(boundaryRef.current),
          CLOUD_CODE_MONSTER_SIZE
        );

        setPosition(() => next);
        onStep(next, 1.45);
        scheduleStep();
      }, CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS);
    };

    scheduleStep();

    return () => {
      clearStepTimer();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, targetId, !!position, boundaryRef, cancel, clearStepTimer, onArrive, onStep, setPosition]);

  return { isWalking, isIdlingAtTarget, walkDirection };
}

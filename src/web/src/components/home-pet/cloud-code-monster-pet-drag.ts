"use client";

import {
  type Dispatch,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";

import {
  calculateMonsterWalkIntensity,
  clampPetPosition,
  getBounds,
  getMonsterFootstepIntervalMs,
  hasViolentMonsterDirectionChange,
  isMonsterFaintShakeEvent,
  isViolentMonsterDrag,
  shouldFaintFromMonsterShake,
  writeStoredPosition,
} from "./cloud-code-monster-pet-activity";
import {
  CLOUD_CODE_MONSTER_FAINT_EVENT_WINDOW_MS,
  CLOUD_CODE_MONSTER_SIZE,
} from "./cloud-code-monster-pet-constants";
import type {
  CloudCodeMonsterActivityId,
  PetPoint,
  StoredCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet-types";

type PetDragTimerKey = "faint" | "notification" | "walkSettle";

type UsePetDragParams = {
  boundaryRef: RefObject<HTMLElement | null>;
  initialPosition?: PetPoint;
  position: PetPoint | null;
  isDragging: boolean;
  fainted: boolean;
  activityState: StoredCloudCodeMonsterActivity | null;
  lastFootstepAtRef: MutableRefObject<number>;
  violentDragEventsRef: MutableRefObject<number[]>;
  setIsDragging: Dispatch<SetStateAction<boolean>>;
  setNotificationActive: Dispatch<SetStateAction<boolean>>;
  setFainted: Dispatch<SetStateAction<boolean>>;
  setWalkDirection: Dispatch<SetStateAction<"left" | "right">>;
  setWalkIntensity: Dispatch<SetStateAction<number>>;
  setPosition: Dispatch<SetStateAction<PetPoint | null>>;
  clearPetTimer: (key: PetDragTimerKey) => void;
  setPetTimer: (
    key: PetDragTimerKey,
    callback: () => void,
    delayMs: number
  ) => void;
  pushFootprint: (nextPosition: PetPoint, intensity: number) => void;
  stopTemporaryMotion: () => void;
  wakeMonsterToDefault: () => void;
  startShockReaction: () => void;
  startShakeReaction: () => void;
  startFaintReaction: () => void;
};

function getPointerPoint(
  event: ReactPointerEvent<HTMLButtonElement>,
  boundary: HTMLElement | null
): PetPoint {
  const boundaryRect = boundary?.getBoundingClientRect();

  return {
    x: event.clientX - (boundaryRect?.left ?? 0),
    y: event.clientY - (boundaryRect?.top ?? 0),
  };
}

function isSleepyActivity(activityId: CloudCodeMonsterActivityId | null) {
  return activityId === "sleeping" || activityId === "dozing" || activityId === "yawning";
}

export function usePetDrag({
  boundaryRef,
  initialPosition,
  position,
  isDragging,
  fainted,
  activityState,
  lastFootstepAtRef,
  violentDragEventsRef,
  setIsDragging,
  setNotificationActive,
  setFainted,
  setWalkDirection,
  setWalkIntensity,
  setPosition,
  clearPetTimer,
  setPetTimer,
  pushFootprint,
  stopTemporaryMotion,
  wakeMonsterToDefault,
  startShockReaction,
  startShakeReaction,
  startFaintReaction,
}: UsePetDragParams) {
  const dragOffsetRef = useRef<PetPoint>({ x: 0, y: 0 });
  const dragStartPointRef = useRef<PetPoint | null>(null);
  const lastPointerRef = useRef<{ point: PetPoint; time: number } | null>(null);
  const lastDragDeltaRef = useRef<PetPoint | null>(null);
  const didDragRef = useRef(false);

  const handlePetClick = useCallback(() => {
    stopTemporaryMotion();
    setNotificationActive(false);
    clearPetTimer("notification");

    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }

    if (isDragging) {
      return;
    }

    if (isSleepyActivity(activityState?.activityId ?? null)) {
      wakeMonsterToDefault();
      return;
    }

    if (activityState?.activityId === "waking") {
      // pointer-down already started the wake; let the animation play out
      return;
    }

    if (activityState?.activityId) {
      wakeMonsterToDefault();
    }

    if (fainted) {
      setFainted(false);
      clearPetTimer("faint");
    }

    startShockReaction();
  }, [
    activityState?.activityId,
    clearPetTimer,
    fainted,
    isDragging,
    setFainted,
    setNotificationActive,
    startShockReaction,
    stopTemporaryMotion,
    wakeMonsterToDefault,
  ]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      const bounds = getBounds(boundaryRef.current);
      const currentPosition =
        position ??
        clampPetPosition(
          initialPosition ?? {
            x: bounds.width - CLOUD_CODE_MONSTER_SIZE.width - 112,
            y: bounds.height * 0.48,
          },
          bounds,
          CLOUD_CODE_MONSTER_SIZE
        );
      const pointerPoint = getPointerPoint(event, boundaryRef.current);
      const now = performance.now();

      if (isSleepyActivity(activityState?.activityId ?? null)) {
        // wake it up but keep the grab: the pet startles awake mid-drag
        wakeMonsterToDefault();
      }

      dragOffsetRef.current = {
        x: pointerPoint.x - currentPosition.x,
        y: pointerPoint.y - currentPosition.y,
      };
      dragStartPointRef.current = pointerPoint;
      lastPointerRef.current = { point: pointerPoint, time: now };
      lastDragDeltaRef.current = null;
      lastFootstepAtRef.current = now;
      didDragRef.current = false;
      stopTemporaryMotion();
      setIsDragging(true);
      setWalkIntensity(1.1);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [
      boundaryRef,
      activityState?.activityId,
      initialPosition,
      lastFootstepAtRef,
      position,
      setIsDragging,
      setWalkIntensity,
      stopTemporaryMotion,
      wakeMonsterToDefault,
    ]
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isDragging) {
        return;
      }

      const bounds = getBounds(boundaryRef.current);
      const pointerPoint = getPointerPoint(event, boundaryRef.current);
      const now = performance.now();
      const lastPointer = lastPointerRef.current ?? {
        point: pointerPoint,
        time: now,
      };
      const deltaX = pointerPoint.x - lastPointer.point.x;
      const deltaY = pointerPoint.y - lastPointer.point.y;
      const nextDelta = { x: deltaX, y: deltaY };
      const distance = Math.hypot(deltaX, deltaY);
      const elapsed = Math.max(1, now - lastPointer.time);
      const intensity = calculateMonsterWalkIntensity(distance, elapsed);
      const nextPosition = clampPetPosition(
        {
          x: pointerPoint.x - dragOffsetRef.current.x,
          y: pointerPoint.y - dragOffsetRef.current.y,
        },
        bounds,
        CLOUD_CODE_MONSTER_SIZE
      );
      const dragStartPoint = dragStartPointRef.current ?? pointerPoint;
      const movementX = Math.abs(pointerPoint.x - dragStartPoint.x);
      const movementY = Math.abs(pointerPoint.y - dragStartPoint.y);

      if (movementX > 3 || movementY > 3) {
        didDragRef.current = true;
      }
      if (Math.abs(deltaX) > 0.5) {
        setWalkDirection(deltaX >= 0 ? "right" : "left");
      }
      const hasSharpDirectionChange = hasViolentMonsterDirectionChange(
        lastDragDeltaRef.current,
        nextDelta
      );

      if (
        !fainted &&
        isViolentMonsterDrag(distance, elapsed, hasSharpDirectionChange)
      ) {
        startShakeReaction();
      }

      if (
        !fainted &&
        isMonsterFaintShakeEvent(distance, elapsed, hasSharpDirectionChange)
      ) {
        violentDragEventsRef.current = [
          ...violentDragEventsRef.current.filter(
            (eventTime) =>
              now - eventTime <= CLOUD_CODE_MONSTER_FAINT_EVENT_WINDOW_MS
          ),
          now,
        ];

        if (shouldFaintFromMonsterShake(violentDragEventsRef.current, now)) {
          startFaintReaction();
          return;
        }
      }

      setWalkIntensity(intensity);
      setPosition(nextPosition);
      lastPointerRef.current = { point: pointerPoint, time: now };
      if (distance > 0.5) {
        lastDragDeltaRef.current = nextDelta;
      }

      if (
        distance > 1 &&
        now - lastFootstepAtRef.current >=
          getMonsterFootstepIntervalMs(intensity)
      ) {
        pushFootprint(nextPosition, intensity);
        lastFootstepAtRef.current = now;
      }
    },
    [
      boundaryRef,
      fainted,
      isDragging,
      lastFootstepAtRef,
      pushFootprint,
      setPosition,
      setWalkDirection,
      setWalkIntensity,
      startFaintReaction,
      startShakeReaction,
      violentDragEventsRef,
    ]
  );

  const stopDragging = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isDragging) {
        return;
      }

      setIsDragging(false);
      violentDragEventsRef.current = [];
      dragStartPointRef.current = null;
      lastPointerRef.current = null;
      lastDragDeltaRef.current = null;

      if (position) {
        writeStoredPosition(position);
      }

      setPetTimer("walkSettle", () => {
        setWalkIntensity(1);
      }, 180);

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [
      isDragging,
      position,
      setIsDragging,
      setPetTimer,
      setWalkIntensity,
      violentDragEventsRef,
    ]
  );

  return {
    handlePetClick,
    handlePointerDown,
    handlePointerMove,
    stopDragging,
  };
}

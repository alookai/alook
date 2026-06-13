"use client";

import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAgentContextSafe } from "@/contexts/agent-context";
import { useInboxCount } from "@/contexts/inbox-count-context";

import styles from "./cloud-code-monster-pet.module.css";

import {
  clampPetPosition,
  createCloudCodeMonsterHiddenState,
  createCloudCodeMonsterIdleState,
  createCloudCodeMonsterSleepingState,
  createCloudCodeMonsterWalkVelocity,
  getBounds,
  getMonsterFootstepIntervalMs,
  readStoredActivity,
  readStoredPosition,
  reflectCloudCodeMonsterWalk,
  resolveCloudCodeMonsterAgentWorkState,
  resolveCloudCodeMonsterPeekPosition,
  resolveCloudCodeMonsterPreviewComebackState,
  resolveCloudCodeMonsterVisibleState,
  shouldCloudCodeMonsterAutoWalk,
  writeStoredActivity,
} from "./cloud-code-monster-pet-activity";
import { CLOUD_CODE_MONSTER_ACTIVITIES } from "./cloud-code-monster-pet-activity-data";
import {
  CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS,
  CLOUD_CODE_MONSTER_ATTENTION_MS,
  CLOUD_CODE_MONSTER_DEEP_SLEEP_MS,
  CLOUD_CODE_MONSTER_DOZE_MS,
  CLOUD_CODE_MONSTER_ERROR_MS,
  CLOUD_CODE_MONSTER_FAINT_MS,
  CLOUD_CODE_MONSTER_NO_WORK_SLEEP_MS,
  CLOUD_CODE_MONSTER_PEEK_INTERVAL_MS,
  CLOUD_CODE_MONSTER_PEEK_MS,
  CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
  CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY,
  CLOUD_CODE_MONSTER_REACTION_MS,
  CLOUD_CODE_MONSTER_SHAKE_REACTION_MS,
  CLOUD_CODE_MONSTER_SIZE,
  CLOUD_CODE_MONSTER_WAKE_MS,
} from "./cloud-code-monster-pet-constants";
import { usePetDrag } from "./cloud-code-monster-pet-drag";
import { useWalkToTarget } from "./cloud-code-monster-pet-walk-target";
import { MonsterSprite } from "./cloud-code-monster-pet-pixel-parts";
import {
  CLOUD_CODE_MONSTER_PET_PRESETS,
  getCloudCodeMonsterPreset,
  readCloudCodeMonsterPetPresetId,
} from "./cloud-code-monster-pet-presets";
import type {
  CloudCodeMonsterActivityId,
  CloudCodeMonsterPeekTarget,
  Footprint,
  PetPoint,
  StoredCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet-types";

export {
  calculateMonsterWalkIntensity,
  clampPetPosition,
  createCloudCodeMonsterHiddenState,
  createCloudCodeMonsterIdleState,
  createCloudCodeMonsterPreviewAwayState,
  createCloudCodeMonsterSleepingState,
  createCloudCodeMonsterWalkVelocity,
  createWalkToTargetVelocity,
  getCloudCodeMonsterExpression,
  getMonsterFootstepIntervalMs,
  hasViolentMonsterDirectionChange,
  isMonsterFaintShakeEvent,
  isViolentMonsterDrag,
  pickCloudCodeMonsterActivity,
  reflectCloudCodeMonsterWalk,
  resolveCloudCodeMonsterAgentWorkState,
  resolveCloudCodeMonsterActivityState,
  resolveCloudCodeMonsterPeekPosition,
  resolveCloudCodeMonsterPreviewComebackState,
  resolveCloudCodeMonsterVisibleState,
  shouldCloudCodeMonsterAutoWalk,
  shouldFaintFromMonsterShake,
  shouldRefreshCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet-activity";
export {
  CLOUD_CODE_MONSTER_ACTIVITIES,
  CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS,
} from "./cloud-code-monster-pet-activity-data";
export {
  CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
  CLOUD_CODE_MONSTER_ATTENTION_MS,
  CLOUD_CODE_MONSTER_DOZE_MS,
  CLOUD_CODE_MONSTER_ERROR_MS,
  CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS,
  CLOUD_CODE_MONSTER_FAINT_MS,
  CLOUD_CODE_MONSTER_NO_WORK_SLEEP_MS,
  CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
  CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY,
  CLOUD_CODE_MONSTER_WAKE_MS,
} from "./cloud-code-monster-pet-constants";
export {
  clampMonsterSpriteEyeOffset,
  CloudCodeMonsterPresetPreview,
  MonsterSprite,
  resolveCloudCodeMonsterPreviewEyeOffset,
  resolvePetSpriteRowId,
} from "./cloud-code-monster-pet-pixel-parts";
export {
  PET_SPRITE_COLS,
  PET_SPRITE_ROW_BY_ID,
  PET_SPRITE_ROWS,
  petSpriteBodyUrl,
  petSpriteEyesUrl,
} from "./cloud-code-monster-pet-sprite-manifest";
export type { PetSpriteRowId } from "./cloud-code-monster-pet-sprite-manifest";
export {
  CLOUD_CODE_MONSTER_PET_PRESETS,
  getCloudCodeMonsterPreset,
  readCloudCodeMonsterPetPresetId,
  writeCloudCodeMonsterPetPresetId,
} from "./cloud-code-monster-pet-presets";
export type {
  CloudCodeMonsterActivityId,
  CloudCodeMonsterExpression,
  CloudCodeMonsterPeekTarget,
  CloudCodeMonsterPetPreset,
  PetBounds,
  PetPoint,
  StoredCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet-types";

export type CloudCodeMonsterPetProps = {
  boundaryRef: RefObject<HTMLElement | null>;
  initialPosition?: PetPoint;
  previewComebackToken?: number;
  notificationToken?: number;
  peekTargets?: CloudCodeMonsterPeekTarget[];
};

const EMPTY_PEEK_TARGETS: CloudCodeMonsterPeekTarget[] = [];
type PetTimerKey =
  | "reaction"
  | "shake"
  | "faint"
  | "autonomousWalk"
  | "peek"
  | "peekStop"
  | "notification"
  | "attention"
  | "noWorkDoze"
  | "noWorkSleep"
  | "typing"
  | "walkSettle"
  | "walkToTargetPeek";

function createPetTimerRecord(): Record<PetTimerKey, number | null> {
  return {
    reaction: null,
    shake: null,
    faint: null,
    autonomousWalk: null,
    peek: null,
    peekStop: null,
    notification: null,
    attention: null,
    noWorkDoze: null,
    noWorkSleep: null,
    typing: null,
    walkSettle: null,
    walkToTargetPeek: null,
  };
}

function usePetTimers() {
  const timersRef = useRef(createPetTimerRecord());

  const clearPetTimer = useCallback((key: PetTimerKey) => {
    const timerId = timersRef.current[key];
    if (timerId === null) {
      return;
    }

    window.clearTimeout(timerId);
    timersRef.current[key] = null;
  }, []);

  const setPetTimer = useCallback(
    (key: PetTimerKey, callback: () => void, delayMs: number) => {
      clearPetTimer(key);
      timersRef.current[key] = window.setTimeout(() => {
        timersRef.current[key] = null;
        callback();
      }, delayMs);
    },
    [clearPetTimer]
  );

  const clearAllPetTimers = useCallback(() => {
    for (const key of Object.keys(timersRef.current) as PetTimerKey[]) {
      clearPetTimer(key);
    }
  }, [clearPetTimer]);

  return { clearAllPetTimers, clearPetTimer, setPetTimer };
}

function roundToQuarter(value: number) {
  return Math.round(value * 4) / 4;
}

function isSleepyActivity(activityId: CloudCodeMonsterActivityId | null) {
  return activityId === "sleeping" || activityId === "dozing" || activityId === "yawning";
}

function isTextEntryElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === "textarea") {
    return true;
  }

  if (tagName !== "input") {
    return false;
  }

  const input = target as HTMLInputElement;
  const inputType = input.type.toLowerCase();
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(inputType);
}

export type CloudCodeMonsterCursorPose = {
  eye: PetPoint;
  leanDeg: number;
  stretchX: number;
  stretchY: number;
  shadowShift: number;
};

export const EMPTY_CLOUD_CODE_MONSTER_CURSOR_POSE: CloudCodeMonsterCursorPose =
  {
    eye: { x: 0, y: 0 },
    leanDeg: 0,
    stretchX: 1,
    stretchY: 1,
    shadowShift: 0,
  };

/**
 * Cursor-following pose: the eyes track the cursor and the body gently leans
 * and stretches toward it. While walking/dragging/sleeping the sprite row
 * animations own the transform, so the stretch never applies mid-drag.
 */
export function resolveCloudCodeMonsterCursorPose(
  cursor: PetPoint,
  position: PetPoint,
  size = CLOUD_CODE_MONSTER_SIZE
): CloudCodeMonsterCursorPose {
  const faceCenter = {
    x: position.x + size.width * 0.5,
    y: position.y + size.height * 0.45,
  };
  const relX = cursor.x - faceCenter.x;
  const relY = cursor.y - faceCenter.y;
  const distance = Math.hypot(relX, relY);

  if (distance <= 1) {
    return EMPTY_CLOUD_CODE_MONSTER_CURSOR_POSE;
  }

  const pull = Math.min(1, distance / 240);
  const dirX = relX / distance;
  const dirY = relY / distance;
  const eyeMaxX = 5.5;
  const eyeMaxY = 4;
  // cursor above -> stand a little taller; below -> settle a little flatter
  const verticalReach = -dirY * pull;

  return {
    eye: {
      x: roundToQuarter(dirX * eyeMaxX * pull),
      y: roundToQuarter(dirY * eyeMaxY * pull),
    },
    leanDeg: roundToQuarter(dirX * 3.5 * pull),
    stretchX: Math.round((1 - verticalReach * 0.025) * 1000) / 1000,
    stretchY: Math.round((1 + verticalReach * 0.045) * 1000) / 1000,
    shadowShift: roundToQuarter(dirX * 3 * pull),
  };
}

export function resolveCloudCodeMonsterEyeOffset(
  cursor: PetPoint,
  position: PetPoint,
  size = CLOUD_CODE_MONSTER_SIZE
): PetPoint {
  return resolveCloudCodeMonsterCursorPose(cursor, position, size).eye;
}

export function CloudCodeMonsterPet({
  boundaryRef,
  initialPosition,
  previewComebackToken = 0,
  notificationToken = 0,
  peekTargets = EMPTY_PEEK_TARGETS,
}: CloudCodeMonsterPetProps) {
  const [activityState, setActivityState] =
    useState<StoredCloudCodeMonsterActivity | null>(null);
  const [position, setPosition] = useState<PetPoint | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAutoWalking, setIsAutoWalking] = useState(false);
  const [isPeeking, setIsPeeking] = useState(false);
  const [notificationActive, setNotificationActive] = useState(false);
  const [isUserTyping, setIsUserTyping] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [shaken, setShaken] = useState(false);
  const [fainted, setFainted] = useState(false);
  const [presetId, setPresetId] = useState(
    CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id
  );
  const [walkIntensity, setWalkIntensity] = useState(1);
  const [walkDirection, setWalkDirection] = useState<"left" | "right">("right");
  const [cursorPose, setCursorPose] = useState<CloudCodeMonsterCursorPose>(
    EMPTY_CLOUD_CODE_MONSTER_CURSOR_POSE
  );
  const [deepSleeping, setDeepSleeping] = useState(false);
  const [footprints, setFootprints] = useState<Footprint[]>([]);
  const lastNotificationTokenRef = useRef(0);
  const lastFootstepAtRef = useRef(0);
  const autoWalkVelocityRef = useRef<PetPoint | null>(null);
  const nextFootprintIdRef = useRef(1);
  const nextFootSideRef = useRef<"left" | "right">("left");
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const violentDragEventsRef = useRef<number[]>([]);
  const peekTargetsRef = useRef(peekTargets);
  const { clearAllPetTimers, clearPetTimer, setPetTimer } = usePetTimers();

  useEffect(() => {
    const syncPreset = (nextPresetId?: string | null) => {
      setPresetId(
        nextPresetId
          ? getCloudCodeMonsterPreset(nextPresetId).id
          : readCloudCodeMonsterPetPresetId()
      );
    };
    const handlePresetChange = (event: Event) => {
      syncPreset(
        (event as CustomEvent<{ presetId?: string }>).detail?.presetId
      );
    };
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY) {
        syncPreset(event.newValue);
      }
    };

    syncPreset();
    window.addEventListener(
      CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
      handlePresetChange
    );
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener(
        CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
        handlePresetChange
      );
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  useEffect(() => {
    const nextState = resolveCloudCodeMonsterVisibleState(readStoredActivity());
    writeStoredActivity(nextState);
    setActivityState(nextState);

    const handleVisibility = () => {
      const now = Date.now();

      setActivityState((current) => {
        const nextState =
          document.visibilityState === "hidden"
            ? createCloudCodeMonsterHiddenState(current, now)
            : resolveCloudCodeMonsterVisibleState(
                current ?? readStoredActivity(),
                now
              );
        writeStoredActivity(nextState);
        return nextState;
      });
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (previewComebackToken <= 0) {
      return;
    }

    const nextState = resolveCloudCodeMonsterPreviewComebackState();
    writeStoredActivity(nextState);
    setActivityState(nextState);
  }, [previewComebackToken]);

  useEffect(() => {
    const syncPosition = () => {
      const bounds = getBounds(boundaryRef.current);

      setPosition((currentPosition) =>
        currentPosition
          ? clampPetPosition(currentPosition, bounds, CLOUD_CODE_MONSTER_SIZE)
          : clampPetPosition(
              initialPosition ?? readStoredPosition() ?? {
                x: bounds.width - CLOUD_CODE_MONSTER_SIZE.width - 112,
                y: Math.min(
                  bounds.height * 0.48,
                  bounds.height - CLOUD_CODE_MONSTER_SIZE.height - 120
                ),
              },
              bounds,
              CLOUD_CODE_MONSTER_SIZE
            )
      );
    };

    syncPosition();
    window.addEventListener("resize", syncPosition);
    if (typeof ResizeObserver !== "undefined" && boundaryRef.current) {
      resizeObserverRef.current = new ResizeObserver(syncPosition);
      resizeObserverRef.current.observe(boundaryRef.current);
    }

    return () => {
      window.removeEventListener("resize", syncPosition);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [boundaryRef, initialPosition]);

  useEffect(() => {
    return clearAllPetTimers;
  }, [clearAllPetTimers]);

  useEffect(() => {
    const markTyping = (event: Event) => {
      if (!isTextEntryElement(event.target)) {
        return;
      }

      setIsUserTyping(true);
      setPetTimer("typing", () => {
        setIsUserTyping(false);
      }, 2_200);
    };
    const clearTypingIfLeavingText = (event: Event) => {
      if (isTextEntryElement(event.target)) {
        setPetTimer("typing", () => {
          setIsUserTyping(false);
        }, 250);
      }
    };

    window.addEventListener("keydown", markTyping, true);
    window.addEventListener("input", markTyping, true);
    window.addEventListener("compositionstart", markTyping, true);
    window.addEventListener("compositionupdate", markTyping, true);
    window.addEventListener("focusout", clearTypingIfLeavingText, true);

    return () => {
      window.removeEventListener("keydown", markTyping, true);
      window.removeEventListener("input", markTyping, true);
      window.removeEventListener("compositionstart", markTyping, true);
      window.removeEventListener("compositionupdate", markTyping, true);
      window.removeEventListener("focusout", clearTypingIfLeavingText, true);
      clearPetTimer("typing");
    };
  }, [clearPetTimer, setPetTimer]);

  const activity = useMemo(() => {
    if (!activityState?.activityId) {
      return null;
    }

    return CLOUD_CODE_MONSTER_ACTIVITIES.find(
      (item) => item.id === activityState.activityId
    );
  }, [activityState]);
  const preset = useMemo(() => getCloudCodeMonsterPreset(presetId), [presetId]);
  const isWalkingBasic = isDragging || isAutoWalking;
  const hasPosition = position !== null;
  const hasPeekTargets = peekTargets.length > 0;
  const shouldAutoWalk = shouldCloudCodeMonsterAutoWalk(
    activityState?.activityId ?? null
  );

  useEffect(() => {
    peekTargetsRef.current = peekTargets;
  }, [peekTargets]);

  // --- Inbox walk-to-target integration ---
  const { count: inboxCount } = useInboxCount();
  const [inboxWalkEnabled, setInboxWalkEnabled] = useState(false);
  const inboxDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (inboxCount > 0 && !fainted && !isDragging) {
      if (inboxDebounceRef.current === null) {
        inboxDebounceRef.current = window.setTimeout(() => {
          inboxDebounceRef.current = null;
          setInboxWalkEnabled(true);
        }, 300);
      }
    } else if (inboxCount === 0) {
      if (inboxDebounceRef.current !== null) {
        window.clearTimeout(inboxDebounceRef.current);
        inboxDebounceRef.current = null;
      }
      setInboxWalkEnabled(false);
    }

    return () => {
      if (inboxDebounceRef.current !== null) {
        window.clearTimeout(inboxDebounceRef.current);
        inboxDebounceRef.current = null;
      }
    };
  }, [inboxCount, fainted, isDragging]);

  const handleWalkToTargetStep = useCallback((nextPosition: PetPoint, intensity: number) => {
    setWalkIntensity(intensity);
    const now = performance.now();
    if (now - lastFootstepAtRef.current >= getMonsterFootstepIntervalMs(intensity)) {
      const side = nextFootSideRef.current;
      nextFootSideRef.current = side === "left" ? "right" : "left";
      const sideOffset = side === "left" ? 25 : 52;
      setFootprints((current) => [
        ...current.slice(-13),
        {
          id: nextFootprintIdRef.current++,
          x: nextPosition.x + sideOffset,
          y: nextPosition.y + CLOUD_CODE_MONSTER_SIZE.height - 7,
          side,
          intensity,
        },
      ]);
      lastFootstepAtRef.current = now;
    }
  }, []);

  const handleWalkToTargetArrive = useCallback(() => {
    setIsPeeking(true);
    setWalkIntensity(1);
    setPetTimer("walkToTargetPeek", () => {
      setIsPeeking(false);
      // Re-peek periodically while inbox > 0
      const schedulePeek = () => {
        setPetTimer("walkToTargetPeek", () => {
          setIsPeeking(true);
          setPetTimer("peekStop", () => {
            setIsPeeking(false);
            schedulePeek();
          }, CLOUD_CODE_MONSTER_PEEK_MS);
        }, CLOUD_CODE_MONSTER_PEEK_INTERVAL_MS);
      };
      schedulePeek();
    }, CLOUD_CODE_MONSTER_PEEK_MS);
  }, [setPetTimer]);

  const walkToTarget = useWalkToTarget({
    boundaryRef,
    targetId: inboxWalkEnabled ? "inbox" : null,
    enabled: inboxWalkEnabled && !isDragging && !reacting && !shaken && !fainted,
    position,
    setPosition,
    onArrive: handleWalkToTargetArrive,
    onStep: handleWalkToTargetStep,
  });

  const isWalkingToTarget = walkToTarget.isWalking || walkToTarget.isIdlingAtTarget;
  const isWalking = isWalkingBasic || walkToTarget.isWalking;
  const effectiveWalkDirection = isWalkingToTarget ? walkToTarget.walkDirection : walkDirection;
  const wasWalkingToTargetRef = useRef(false);

  useEffect(() => {
    if (wasWalkingToTargetRef.current && !isWalkingToTarget) {
      clearPetTimer("walkToTargetPeek");
      setIsPeeking(false);
    }
    wasWalkingToTargetRef.current = isWalkingToTarget;
  }, [isWalkingToTarget, clearPetTimer]);

  // --- Working state: lock activity when agents have running tasks ---
  const agentCtx = useAgentContextSafe();
  const activeAgentTaskCount = agentCtx?.activeTaskDetails.length ?? 0;
  const activeAgentTaskCountRef = useRef(activeAgentTaskCount);
  const hasRunningTasks = activeAgentTaskCount > 0;
  const subscribeWs = agentCtx?.subscribeWs;

  useEffect(() => {
    activeAgentTaskCountRef.current = activeAgentTaskCount;
  }, [activeAgentTaskCount]);

  const setPlatformActivity = useCallback((activityId: CloudCodeMonsterActivityId | null) => {
    const nextState = {
      activityId,
      updatedAt: Date.now(),
      hiddenAt: null,
    };
    writeStoredActivity(nextState);
    setActivityState(nextState);
  }, []);

  useEffect(() => {
    if (isUserTyping) {
      clearPetTimer("attention");
      clearPetTimer("noWorkSleep");
      clearPetTimer("noWorkDoze");
      return;
    }

    if (hasRunningTasks) {
      const wasSleeping = isSleepyActivity(activityState?.activityId ?? null);
      clearPetTimer("noWorkSleep");
      clearPetTimer("noWorkDoze");
      if (isWalkingToTarget) {
        return;
      }

      if (wasSleeping) {
        setPlatformActivity("waking");
        setPetTimer("attention", () => {
          setActivityState((current) => {
            const next = resolveCloudCodeMonsterAgentWorkState(
              activeAgentTaskCountRef.current,
              current,
              Date.now()
            );
            writeStoredActivity(next);
            return next;
          });
        }, CLOUD_CODE_MONSTER_WAKE_MS);
        return;
      }

      setActivityState((current) => {
        const next = resolveCloudCodeMonsterAgentWorkState(
          activeAgentTaskCount,
          current,
          Date.now()
        );
        if (
          current?.activityId === next.activityId &&
          current.hiddenAt === next.hiddenAt
        ) {
          return current;
        }
        writeStoredActivity(next);
        return next;
      });
      return;
    }

    if (
      isWalkingToTarget ||
      isDragging ||
      isUserTyping ||
      reacting ||
      shaken ||
      fainted ||
      notificationActive
    ) {
      clearPetTimer("attention");
      clearPetTimer("noWorkDoze");
      clearPetTimer("noWorkSleep");
      return;
    }

    setActivityState((current) => {
      if (
        !current ||
        current.activityId === "sleeping" ||
        current.activityId === "dozing" ||
        current.activityId === null
      ) {
        return current;
      }
      const nextState = createCloudCodeMonsterIdleState();
      writeStoredActivity(nextState);
      return nextState;
    });

    setPetTimer("noWorkDoze", () => {
      setActivityState((current) => {
        if (current?.activityId === "sleeping" || current?.activityId === "dozing") {
          return current;
        }
        const nextState: StoredCloudCodeMonsterActivity = {
          activityId: "dozing",
          updatedAt: Date.now(),
          hiddenAt: null,
        };
        writeStoredActivity(nextState);
        return nextState;
      });
    }, CLOUD_CODE_MONSTER_DOZE_MS);

    setPetTimer("noWorkSleep", () => {
      setActivityState((current) => {
        if (current?.activityId === "sleeping") {
          return current;
        }
        const nextState = createCloudCodeMonsterSleepingState();
        writeStoredActivity(nextState);
        return nextState;
      });
    }, CLOUD_CODE_MONSTER_NO_WORK_SLEEP_MS);

    return () => {
      clearPetTimer("noWorkDoze");
      clearPetTimer("noWorkSleep");
    };
  }, [
    activeAgentTaskCount,
    activityState?.activityId,
    clearPetTimer,
    fainted,
    hasRunningTasks,
    isDragging,
    isWalkingToTarget,
    isUserTyping,
    notificationActive,
    reacting,
    setPlatformActivity,
    setPetTimer,
    shaken,
  ]);

  const pushFootprint = useCallback((nextPosition: PetPoint, intensity: number) => {
    const side = nextFootSideRef.current;
    nextFootSideRef.current = side === "left" ? "right" : "left";
    const sideOffset = side === "left" ? 25 : 52;

    setFootprints((current) => [
      ...current.slice(-13),
      {
        id: nextFootprintIdRef.current++,
        x: nextPosition.x + sideOffset,
        y: nextPosition.y + CLOUD_CODE_MONSTER_SIZE.height - 7,
        side,
        intensity,
      },
    ]);
  }, []);

  useEffect(() => {
    if (
      !hasPosition ||
      !activityState?.activityId ||
      !shouldAutoWalk ||
      isDragging ||
      reacting ||
      shaken ||
      fainted ||
      isPeeking ||
      isWalkingToTarget
    ) {
      setIsAutoWalking(false);
      setWalkIntensity(1);
      autoWalkVelocityRef.current = null;
      return;
    }

    setIsAutoWalking(true);
    autoWalkVelocityRef.current ??= createCloudCodeMonsterWalkVelocity();

    const scheduleNextWalkStep = () => {
      setPetTimer("autonomousWalk", () => {
        const bounds = getBounds(boundaryRef.current);
        const intensity = 1.45;

        setWalkIntensity(intensity);
        setPosition((currentPosition) => {
          const velocity = autoWalkVelocityRef.current;

          if (!currentPosition || !velocity) {
            return currentPosition;
          }

          const nextWalk = reflectCloudCodeMonsterWalk(
            currentPosition,
            velocity,
            bounds,
            CLOUD_CODE_MONSTER_SIZE
          );
          autoWalkVelocityRef.current = nextWalk.velocity;
          setWalkDirection(nextWalk.velocity.x >= 0 ? "right" : "left");

          const now = performance.now();
          if (
            now - lastFootstepAtRef.current >=
            getMonsterFootstepIntervalMs(intensity)
          ) {
            pushFootprint(nextWalk.position, intensity);
            lastFootstepAtRef.current = now;
          }

          return nextWalk.position;
        });
        scheduleNextWalkStep();
      }, CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS);
    };

    setPetTimer(
      "autonomousWalk",
      scheduleNextWalkStep,
      CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS
    );

    return () => {
      clearPetTimer("autonomousWalk");
    };
  }, [
    activityState?.activityId,
    boundaryRef,
    fainted,
    hasPosition,
    isDragging,
    isPeeking,
    isWalkingToTarget,
    reacting,
    clearPetTimer,
    pushFootprint,
    shaken,
    shouldAutoWalk,
    setPetTimer,
  ]);

  useEffect(() => {
    if (
      !hasPosition ||
      !hasPeekTargets ||
      isDragging ||
      reacting ||
      shaken ||
      fainted ||
      isWalkingToTarget
    ) {
      return;
    }

    setPetTimer("peek", () => {
      const currentPeekTargets = peekTargetsRef.current;
      const target =
        currentPeekTargets[
          Math.floor(Math.random() * currentPeekTargets.length)
        ] ?? currentPeekTargets[0];

      if (!target) {
        return;
      }

      const bounds = getBounds(boundaryRef.current);
      const nextPosition = resolveCloudCodeMonsterPeekPosition(
        target,
        boundaryRef.current,
        bounds
      );

      setIsAutoWalking(false);
      autoWalkVelocityRef.current = null;
      setIsPeeking(true);
      setWalkIntensity(1);
      setPosition(nextPosition);

      setPetTimer("peekStop", () => {
        setIsPeeking(false);
      }, CLOUD_CODE_MONSTER_PEEK_MS);
    }, CLOUD_CODE_MONSTER_PEEK_INTERVAL_MS + Math.random() * 4_000);

    return () => {
      clearPetTimer("peek");
    };
  }, [
    boundaryRef,
    clearPetTimer,
    fainted,
    hasPeekTargets,
    hasPosition,
    isDragging,
    isWalkingToTarget,
    reacting,
    shaken,
    setPetTimer,
  ]);

  const wakeMonsterToDefault = useCallback(() => {
    if (isSleepyActivity(activityState?.activityId ?? null)) {
      setPlatformActivity("waking");
      setPetTimer("attention", () => {
        setPlatformActivity(null);
      }, CLOUD_CODE_MONSTER_WAKE_MS);
      return;
    }

    setActivityState((current) => {
      if (current && !current.activityId && current.hiddenAt === null) {
        return current;
      }

      const nextState = createCloudCodeMonsterIdleState();
      writeStoredActivity(nextState);
      return nextState;
    });
  }, [activityState?.activityId, setPetTimer, setPlatformActivity]);

  const stopTemporaryMotion = useCallback(() => {
    setIsAutoWalking(false);
    setIsPeeking(false);
    violentDragEventsRef.current = [];
    autoWalkVelocityRef.current = null;

    clearPetTimer("autonomousWalk");
    clearPetTimer("peek");
    clearPetTimer("peekStop");
    clearPetTimer("walkToTargetPeek");
  }, [clearPetTimer]);

  useEffect(() => {
    if (isDragging || fainted || notificationActive) {
      return;
    }

    if (!isUserTyping) {
      if (activityState?.activityId === "thinking" || activityState?.activityId === "typing") {
        setPlatformActivity(null);
      }
      return;
    }

    clearPetTimer("noWorkDoze");
    clearPetTimer("noWorkSleep");
    stopTemporaryMotion();

    if (activityState?.activityId === "thinking" || activityState?.activityId === "waking") {
      return;
    }

    if (isSleepyActivity(activityState?.activityId ?? null)) {
      setPlatformActivity("waking");
      setPetTimer("attention", () => {
        setPlatformActivity("thinking");
      }, CLOUD_CODE_MONSTER_WAKE_MS);
      return;
    }

    setPlatformActivity("thinking");
  }, [
    activityState?.activityId,
    clearPetTimer,
    fainted,
    isDragging,
    isUserTyping,
    notificationActive,
    setPetTimer,
    setPlatformActivity,
    stopTemporaryMotion,
  ]);

  useEffect(() => {
    if (!subscribeWs) {
      return;
    }

    const showTransientActivity = (
      activityId: CloudCodeMonsterActivityId,
      durationMs = CLOUD_CODE_MONSTER_ATTENTION_MS
    ) => {
      stopTemporaryMotion();
      const showActivity = () => {
        setPlatformActivity(activityId);
        setPetTimer("attention", () => {
          setActivityState((current) => {
            if (current?.activityId !== activityId) {
              return current;
            }
            const nextState = createCloudCodeMonsterIdleState();
            writeStoredActivity(nextState);
            return nextState;
          });
        }, durationMs);
      };

      if (isSleepyActivity(activityState?.activityId ?? null)) {
        setPlatformActivity("waking");
        setPetTimer("attention", showActivity, CLOUD_CODE_MONSTER_WAKE_MS);
        return;
      }

      showActivity();
    };

    return subscribeWs((msg) => {
      if (msg.type === "task.created") {
        showTransientActivity("carrying", 3_000);
      } else if (msg.type === "artifact.uploaded" || msg.type === "workspace.files") {
        showTransientActivity("carrying", 3_000);
      } else if (msg.type === "email.received") {
        showTransientActivity("notification", CLOUD_CODE_MONSTER_ATTENTION_MS);
      } else if (msg.type === "task.updated") {
        if (msg.status === "completed") {
          showTransientActivity("attention", CLOUD_CODE_MONSTER_ATTENTION_MS);
        } else if (msg.status === "failed") {
          showTransientActivity("error", CLOUD_CODE_MONSTER_ERROR_MS);
        } else if (msg.status === "cancelled" || msg.status === "superseded") {
          showTransientActivity("sweeping", 3_000);
        }
      }
    });
  }, [
    activityState?.activityId,
    setPetTimer,
    setPlatformActivity,
    stopTemporaryMotion,
    subscribeWs,
  ]);

  const startShockReaction = useCallback(() => {
    setReacting(true);
    setPetTimer("reaction", () => {
      setReacting(false);
    }, CLOUD_CODE_MONSTER_REACTION_MS);
  }, [setPetTimer]);

  useEffect(() => {
    if (
      notificationToken <= 0 ||
      notificationToken === lastNotificationTokenRef.current
    ) {
      return;
    }
    lastNotificationTokenRef.current = notificationToken;

    stopTemporaryMotion();
    const showNotification = () => {
      startShockReaction();
      setPlatformActivity("notification");
      setNotificationActive(true);

      setPetTimer("notification", () => {
        setNotificationActive(false);
        setActivityState((current) => {
          if (current?.activityId !== "notification") {
            return current;
          }
          const nextState = createCloudCodeMonsterIdleState();
          writeStoredActivity(nextState);
          return nextState;
        });
      }, CLOUD_CODE_MONSTER_REACTION_MS + 1_500);
    };

    if (isSleepyActivity(activityState?.activityId ?? null)) {
      setPlatformActivity("waking");
      setPetTimer("attention", showNotification, CLOUD_CODE_MONSTER_WAKE_MS);
      return;
    }

    if (activityState?.activityId) {
      wakeMonsterToDefault();
    }
    showNotification();
  }, [
    activityState?.activityId,
    notificationToken,
    setPlatformActivity,
    setPetTimer,
    startShockReaction,
    stopTemporaryMotion,
    wakeMonsterToDefault,
  ]);

  const startShakeReaction = useCallback(() => {
    if (fainted) {
      return;
    }

    if (activityState?.activityId) {
      wakeMonsterToDefault();
    }

    setShaken(true);
    setPetTimer("shake", () => {
      setShaken(false);
    }, CLOUD_CODE_MONSTER_SHAKE_REACTION_MS);
  }, [
    activityState?.activityId,
    fainted,
    setPetTimer,
    wakeMonsterToDefault,
  ]);

  const startFaintReaction = useCallback(() => {
    clearPetTimer("faint");
    clearPetTimer("reaction");
    clearPetTimer("shake");

    wakeMonsterToDefault();
    stopTemporaryMotion();
    setReacting(false);
    setShaken(false);
    setFainted(true);
    setWalkIntensity(1);

    setPetTimer("faint", () => {
      setFainted(false);
    }, CLOUD_CODE_MONSTER_FAINT_MS);
  }, [
    clearPetTimer,
    setPetTimer,
    stopTemporaryMotion,
    wakeMonsterToDefault,
  ]);

  const {
    handlePetClick,
    handlePointerDown,
    handlePointerMove,
    stopDragging,
  } = usePetDrag({
    activityState,
    boundaryRef,
    fainted,
    initialPosition,
    isDragging,
    lastFootstepAtRef,
    position,
    pushFootprint,
    setFainted,
    setIsDragging,
    setNotificationActive,
    setPetTimer,
    setPosition,
    setWalkDirection,
    setWalkIntensity,
    clearPetTimer,
    startFaintReaction,
    startShakeReaction,
    startShockReaction,
    stopTemporaryMotion,
    violentDragEventsRef,
    wakeMonsterToDefault,
  });

  useEffect(() => {
    if (!position) {
      setCursorPose(EMPTY_CLOUD_CODE_MONSTER_CURSOR_POSE);
      return;
    }

    const handlePointerLook = (event: PointerEvent) => {
      const boundaryRect = boundaryRef.current?.getBoundingClientRect();
      const cursor = {
        x: event.clientX - (boundaryRect?.left ?? 0),
        y: event.clientY - (boundaryRect?.top ?? 0),
      };
      const nextPose = resolveCloudCodeMonsterCursorPose(cursor, position);
      setCursorPose((current) =>
        current.eye.x === nextPose.eye.x &&
        current.eye.y === nextPose.eye.y &&
        current.leanDeg === nextPose.leanDeg &&
        current.stretchX === nextPose.stretchX &&
        current.stretchY === nextPose.stretchY &&
        current.shadowShift === nextPose.shadowShift
          ? current
          : nextPose
      );
    };

    window.addEventListener("pointermove", handlePointerLook, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerLook);
    };
  }, [boundaryRef, position]);

  // sleeping starts with a ~10s snore phase, then settles into deep sleep.
  // Derived from the stored activity timestamp so remounts/reloads mid-sleep
  // still reach the deep phase on schedule.
  const sleepingSince =
    activityState?.activityId === "sleeping" ? activityState.updatedAt : null;
  useEffect(() => {
    if (sleepingSince === null) {
      setDeepSleeping(false);
      return;
    }

    const remainingMs =
      CLOUD_CODE_MONSTER_DEEP_SLEEP_MS - (Date.now() - sleepingSince);
    if (remainingMs <= 0) {
      setDeepSleeping(true);
      return;
    }

    setDeepSleeping(false);
    const timerId = window.setTimeout(() => {
      setDeepSleeping(true);
    }, remainingMs);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [sleepingSince]);

  if (!position || !activityState) {
    return null;
  }

  const displayedActivity = isPeeking || fainted ? null : activity;
  // Sprite rows key off the stored activity id — not the display lookup, which
  // used to drop "sleeping" and left the pet stuck on idle during sleep.
  const spriteActivityId =
    fainted || isPeeking ? null : activityState.activityId;
  const mirrorSign = effectiveWalkDirection === "left" ? -1 : 1;
  const visualEyeOffset = {
    x: cursorPose.eye.x * mirrorSign,
    y: cursorPose.eye.y,
  };

  return (
    <div className={styles.petLayer}>
      <div className={styles.footsteps} aria-hidden="true">
        {footprints.map((footprint) => (
          <span
            key={footprint.id}
            className={styles.footprint}
            data-side={footprint.side}
            onAnimationEnd={() => {
              setFootprints((currentFootprints) =>
                currentFootprints.filter((item) => item.id !== footprint.id)
              );
            }}
            style={
              {
                "--monster-footprint-x": `${footprint.x}px`,
                "--monster-footprint-y": `${footprint.y}px`,
                "--monster-footprint-scale": String(
                  Math.min(1.35, Math.max(0.75, footprint.intensity / 1.45))
                ),
              } as CSSProperties
            }
          />
        ))}
      </div>
      <aside
        aria-label={`${preset.name} pixel PET: ${
          fainted
            ? "fainted"
            : isPeeking
              ? "peeking at work"
              : displayedActivity?.label ?? "idle"
        }`}
        className={styles.pet}
        data-activity={spriteActivityId ?? "idle"}
        data-dragging={isDragging}
        data-walking={isWalking}
        data-direction={effectiveWalkDirection}
        data-reaction={shaken ? "shake" : reacting ? "shock" : "none"}
        data-reacting={reacting}
        data-shaken={shaken}
        data-fainted={fainted}
        data-peeking={isPeeking}
        data-notifying={notificationActive}
        style={
          {
            "--cloud-code-monster-pet-x": `${position.x}px`,
            "--cloud-code-monster-pet-y": `${position.y}px`,
            "--monster-walk-duration": `${Math.round(
              360 / Math.max(0.75, walkIntensity)
            )}ms`,
            "--monster-walk-lift": `-${Math.round(
              2 * Math.max(0.75, walkIntensity)
            )}px`,
            "--monster-cursor-lean": `${cursorPose.leanDeg * mirrorSign}deg`,
            "--monster-cursor-stretch-x": String(cursorPose.stretchX),
            "--monster-cursor-stretch-y": String(cursorPose.stretchY),
            "--monster-cursor-shadow-x": `${
              cursorPose.shadowShift * mirrorSign
            }px`,
          } as CSSProperties
        }
      >
        <button
          type="button"
          className={styles.button}
          data-dragging={isDragging}
          data-fainted={fainted}
          onClick={handlePetClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onLostPointerCapture={stopDragging}
          aria-label={`Claude Code pixel monster is ${
            fainted
              ? "fainted"
              : isPeeking
                ? "peeking at work"
                : displayedActivity?.label ?? "idle"
          }. Click to ${
            displayedActivity || fainted || isPeeking ? "interrupt it" : "notice it"
          }, drag to make it walk.`}
        >
          <MonsterSprite
            activityId={spriteActivityId}
            preset={preset}
            reacting={reacting}
            shaken={shaken}
            fainted={fainted}
            walking={isWalking}
            deepSleeping={deepSleeping}
            eyeOffset={visualEyeOffset}
          />
        </button>
      </aside>
    </div>
  );
}

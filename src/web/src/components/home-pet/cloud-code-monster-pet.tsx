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
import { MonsterSvg } from "./cloud-code-monster-pet-pixel-parts";
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
export { CloudCodeMonsterPresetPreview } from "./cloud-code-monster-pet-pixel-parts";
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
const EMPTY_EYE_OFFSET: PetPoint = { x: 0, y: 0 };
const EMPTY_CURSOR_POSE = {
  bodyX: 0,
  bodyY: 0,
  leanDeg: 0,
  shadowScaleX: 1,
  shadowX: 0,
  skewDeg: 0,
  stretchX: 1,
  stretchY: 1,
};
type CloudCodeMonsterCursorPose = typeof EMPTY_CURSOR_POSE;
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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

export function resolveCloudCodeMonsterCursorPose(
  cursor: PetPoint,
  position: PetPoint,
  size = CLOUD_CODE_MONSTER_SIZE
): CloudCodeMonsterCursorPose & { eyeX: number; eyeY: number } {
  const faceCenter = {
    x: position.x + size.width * 0.5,
    y: position.y + size.height * 0.45,
  };
  const relX = cursor.x - faceCenter.x;
  const relY = cursor.y - faceCenter.y;
  const distance = Math.hypot(relX, relY);

  if (distance <= 1) {
    return { ...EMPTY_CURSOR_POSE, eyeX: 0, eyeY: 0 };
  }

  const directionX = relX / distance;
  const directionY = relY / distance;
  const pull = Math.min(1, distance / 240);
  const eyeMaxX = 5.5;
  const eyeMaxY = 4;
  const bodyMaxX = 2;
  const bodyMaxY = 1.25;

  return {
    eyeX: roundToQuarter(directionX * eyeMaxX * pull),
    eyeY: roundToQuarter(directionY * eyeMaxY * pull),
    bodyX: roundToQuarter(directionX * bodyMaxX * pull),
    bodyY: roundToQuarter(directionY * bodyMaxY * pull),
    leanDeg: Number((directionX * 2.8 * pull).toFixed(2)),
    shadowScaleX: Number((1 + Math.abs(directionX) * 0.08 * pull).toFixed(3)),
    shadowX: roundToQuarter(directionX * 0.8 * pull),
    skewDeg: Number((directionX * 1.6 * pull).toFixed(2)),
    stretchX: Number((1 + Math.abs(directionX) * 0.025 * pull).toFixed(3)),
    stretchY: Number((1 - Math.abs(directionX) * 0.018 * pull).toFixed(3)),
  };
}

export function resolveCloudCodeMonsterEyeOffset(
  cursor: PetPoint,
  position: PetPoint,
  size = CLOUD_CODE_MONSTER_SIZE
): PetPoint {
  const pose = resolveCloudCodeMonsterCursorPose(cursor, position, size);
  return {
    x: pose.eyeX,
    y: pose.eyeY,
  };
}

export function resolveCloudCodeMonsterMotionPose(
  isWalking: boolean,
  direction: "left" | "right",
  intensity: number
) {
  if (!isWalking) {
    return {
      leanDeg: 0,
      skewDeg: 0,
      stretchX: 1,
      stretchY: 1,
    };
  }

  const normalized = clampNumber(intensity, 0.75, 2.4);
  const directionSign = direction === "right" ? 1 : -1;
  const motion = (normalized - 0.75) / 1.65;

  return {
    leanDeg: Number((directionSign * (2.5 + motion * 5)).toFixed(2)),
    skewDeg: Number((directionSign * (1.5 + motion * 4)).toFixed(2)),
    stretchX: Number((1 + motion * 0.07).toFixed(3)),
    stretchY: Number((1 - motion * 0.055).toFixed(3)),
  };
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
  const [eyeOffset, setEyeOffset] = useState<PetPoint>(EMPTY_EYE_OFFSET);
  const [cursorPose, setCursorPose] =
    useState<CloudCodeMonsterCursorPose>(EMPTY_CURSOR_POSE);
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
      setEyeOffset(EMPTY_EYE_OFFSET);
      setCursorPose(EMPTY_CURSOR_POSE);
      return;
    }

    const handlePointerLook = (event: PointerEvent) => {
      const boundaryRect = boundaryRef.current?.getBoundingClientRect();
      const cursor = {
        x: event.clientX - (boundaryRect?.left ?? 0),
        y: event.clientY - (boundaryRect?.top ?? 0),
      };
      const nextPose = resolveCloudCodeMonsterCursorPose(cursor, position);
      const nextOffset = { x: nextPose.eyeX, y: nextPose.eyeY };
      setEyeOffset((current) =>
        current.x === nextOffset.x && current.y === nextOffset.y
          ? current
          : nextOffset
      );
      setCursorPose((current) =>
        current.bodyX === nextPose.bodyX &&
        current.bodyY === nextPose.bodyY &&
        current.leanDeg === nextPose.leanDeg &&
        current.shadowScaleX === nextPose.shadowScaleX &&
        current.shadowX === nextPose.shadowX &&
        current.skewDeg === nextPose.skewDeg &&
        current.stretchX === nextPose.stretchX &&
        current.stretchY === nextPose.stretchY
          ? current
          : nextPose
      );
    };

    window.addEventListener("pointermove", handlePointerLook, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerLook);
    };
  }, [boundaryRef, position]);

  if (!position || !activityState) {
    return null;
  }

  const displayedActivity = isPeeking || fainted ? null : activity;
  const motionPose = resolveCloudCodeMonsterMotionPose(
    isWalking,
    effectiveWalkDirection,
    walkIntensity
  );
  const mirrorSign = effectiveWalkDirection === "left" ? -1 : 1;
  const visualEyeOffset = {
    x: eyeOffset.x * mirrorSign,
    y: eyeOffset.y,
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
        data-activity={displayedActivity?.id ?? "idle"}
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
            "--monster-walk-intensity": String(walkIntensity),
            "--monster-motion-lean": `${motionPose.leanDeg * mirrorSign}deg`,
            "--monster-motion-skew": `${motionPose.skewDeg * mirrorSign}deg`,
            "--monster-motion-stretch-x": String(motionPose.stretchX),
            "--monster-motion-stretch-y": String(motionPose.stretchY),
            "--monster-cursor-body-x": `${cursorPose.bodyX * mirrorSign}px`,
            "--monster-cursor-body-y": `${cursorPose.bodyY}px`,
            "--monster-cursor-lean": `${cursorPose.leanDeg * mirrorSign}deg`,
            "--monster-cursor-skew": `${cursorPose.skewDeg * mirrorSign}deg`,
            "--monster-cursor-stretch-x": String(cursorPose.stretchX),
            "--monster-cursor-stretch-y": String(cursorPose.stretchY),
            "--monster-cursor-shadow-x": `${cursorPose.shadowX * mirrorSign}px`,
            "--monster-cursor-shadow-scale-x": String(cursorPose.shadowScaleX),
          } as CSSProperties
        }
      >
        {notificationActive ? (
          <span className={styles.notificationBell} aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              className={`${styles.notificationBellPixel} size-6`}
              role="img"
              shapeRendering="crispEdges"
            >
              <rect x="10" y="2" width="4" height="3" fill="#2b2112" />
              <rect x="8" y="5" width="8" height="3" fill="#2b2112" />
              <rect x="6" y="8" width="12" height="8" fill="#2b2112" />
              <rect x="4" y="16" width="16" height="4" fill="#2b2112" />
              <rect x="9" y="20" width="6" height="2" fill="#2b2112" />
              <rect x="10" y="5" width="4" height="2" fill="#ffe37a" />
              <rect x="8" y="8" width="8" height="8" fill="#f4c84f" />
              <rect x="6" y="16" width="12" height="2" fill="#f4c84f" />
              <rect x="9" y="9" width="3" height="7" fill="#ffe37a" />
              <rect x="13" y="18" width="3" height="2" fill="#c8922f" />
            </svg>
          </span>
        ) : null}
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
          <MonsterSvg
            activityId={displayedActivity?.id ?? null}
            preset={preset}
            reacting={reacting}
            shaken={shaken}
            fainted={fainted}
            eyeOffset={visualEyeOffset}
          />
        </button>
      </aside>
    </div>
  );
}

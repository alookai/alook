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
  createCloudCodeMonsterWalkVelocity,
  getBounds,
  getMonsterFootstepIntervalMs,
  readStoredActivity,
  reflectCloudCodeMonsterWalk,
  resolveCloudCodeMonsterPeekPosition,
  resolveCloudCodeMonsterPreviewComebackState,
  resolveCloudCodeMonsterVisibleState,
  shouldCloudCodeMonsterAutoWalk,
  writeStoredActivity,
} from "./cloud-code-monster-pet-activity";
import { CLOUD_CODE_MONSTER_ACTIVITIES } from "./cloud-code-monster-pet-activity-data";
import {
  CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS,
  CLOUD_CODE_MONSTER_FAINT_MS,
  CLOUD_CODE_MONSTER_PEEK_INTERVAL_MS,
  CLOUD_CODE_MONSTER_PEEK_MS,
  CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
  CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY,
  CLOUD_CODE_MONSTER_REACTION_MS,
  CLOUD_CODE_MONSTER_SHAKE_REACTION_MS,
  CLOUD_CODE_MONSTER_SIZE,
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
  createCloudCodeMonsterWalkVelocity,
  createWalkToTargetVelocity,
  getCloudCodeMonsterExpression,
  getMonsterFootstepIntervalMs,
  hasViolentMonsterDirectionChange,
  isMonsterFaintShakeEvent,
  isViolentMonsterDrag,
  pickCloudCodeMonsterActivity,
  reflectCloudCodeMonsterWalk,
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
  CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS,
  CLOUD_CODE_MONSTER_FAINT_MS,
  CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
  CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY,
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
  positionStorageKey?: string;
  previewComebackToken?: number;
  notificationToken?: number;
  peekTargets?: CloudCodeMonsterPeekTarget[];
};

const EMPTY_PEEK_TARGETS: CloudCodeMonsterPeekTarget[] = [];

export function isStoredPetPoint(value: unknown): value is PetPoint {
  if (!value || typeof value !== "object") {
    return false;
  }

  const point = value as PetPoint;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function readStoredPetPosition(storageKey?: string): PetPoint | null {
  if (!storageKey || typeof localStorage === "undefined") {
    return null;
  }

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    return isStoredPetPoint(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredPetPosition(
  storageKey: string | undefined,
  position: PetPoint
) {
  if (!storageKey || typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.setItem(storageKey, JSON.stringify(position));
  } catch {
    // Ignore quota/private-mode failures; the PET can still use in-memory state.
  }
}

type PetTimerKey =
  | "reaction"
  | "shake"
  | "faint"
  | "autonomousWalk"
  | "peek"
  | "peekStop"
  | "notification"
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

export function CloudCodeMonsterPet({
  boundaryRef,
  initialPosition,
  positionStorageKey,
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
  const [reacting, setReacting] = useState(false);
  const [shaken, setShaken] = useState(false);
  const [fainted, setFainted] = useState(false);
  const [presetId, setPresetId] = useState(
    CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id
  );
  const [walkIntensity, setWalkIntensity] = useState(1);
  const [walkDirection, setWalkDirection] = useState<"left" | "right">("right");
  const [footprints, setFootprints] = useState<Footprint[]>([]);
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
      const storedPosition = readStoredPetPosition(positionStorageKey);

      setPosition((currentPosition) =>
        currentPosition
          ? clampPetPosition(currentPosition, bounds, CLOUD_CODE_MONSTER_SIZE)
          : clampPetPosition(
              storedPosition ?? initialPosition ?? {
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
  }, [boundaryRef, initialPosition, positionStorageKey]);

  useEffect(() => {
    if (!position || isDragging || isAutoWalking || isPeeking) {
      return;
    }

    writeStoredPetPosition(positionStorageKey, position);
  }, [isAutoWalking, isDragging, isPeeking, position, positionStorageKey]);

  useEffect(() => {
    return clearAllPetTimers;
  }, [clearAllPetTimers]);

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
  const hasRunningTasks = (agentCtx?.activeTaskDetails.length ?? 0) > 0;
  const workingActivityRef = useRef<CloudCodeMonsterActivityId | null>(null);

  useEffect(() => {
    if (hasRunningTasks && !isWalkingToTarget) {
      if (!workingActivityRef.current) {
        const workingActivities: CloudCodeMonsterActivityId[] = ["coding", "thinking", "reading"];
        workingActivityRef.current =
          workingActivities[Math.floor(Math.random() * workingActivities.length)]!;
      }
      const lockedActivity = workingActivityRef.current;
      setActivityState((current) => {
        if (current?.activityId === lockedActivity) return current;
        const next = { activityId: lockedActivity, updatedAt: Date.now(), hiddenAt: null };
        writeStoredActivity(next);
        return next;
      });
    } else if (!hasRunningTasks) {
      if (workingActivityRef.current) {
        workingActivityRef.current = null;
        const nextState = createCloudCodeMonsterIdleState();
        writeStoredActivity(nextState);
        setActivityState(nextState);
      }
    }
  }, [hasRunningTasks, isWalkingToTarget]);

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
    setActivityState((current) => {
      if (current && !current.activityId && current.hiddenAt === null) {
        return current;
      }

      const nextState = createCloudCodeMonsterIdleState();
      writeStoredActivity(nextState);
      return nextState;
    });
  }, []);

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

  const startShockReaction = useCallback(() => {
    setReacting(true);
    setPetTimer("reaction", () => {
      setReacting(false);
    }, CLOUD_CODE_MONSTER_REACTION_MS);
  }, [setPetTimer]);

  useEffect(() => {
    if (notificationToken <= 0) {
      return;
    }

    stopTemporaryMotion();
    if (activityState?.activityId) {
      wakeMonsterToDefault();
    }
    startShockReaction();
    setNotificationActive(true);

    setPetTimer("notification", () => {
      setNotificationActive(false);
    }, CLOUD_CODE_MONSTER_REACTION_MS + 1_500);
  }, [
    activityState?.activityId,
    notificationToken,
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

  if (!position || !activityState) {
    return null;
  }

  const displayedActivity = isPeeking || fainted ? null : activity;

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
        data-direction={isWalkingToTarget ? walkToTarget.walkDirection : walkDirection}
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
          />
        </button>
      </aside>
    </div>
  );
}

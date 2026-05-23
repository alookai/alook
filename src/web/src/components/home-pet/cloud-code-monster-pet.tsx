"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./cloud-code-monster-pet.module.css";

import {
  calculateMonsterWalkIntensity,
  clampPetPosition,
  createCloudCodeMonsterHiddenState,
  createCloudCodeMonsterIdleState,
  createCloudCodeMonsterPreviewAwayState,
  createCloudCodeMonsterWalkVelocity,
  getBounds,
  getMonsterFootstepIntervalMs,
  hasViolentMonsterDirectionChange,
  isMonsterFaintShakeEvent,
  isViolentMonsterDrag,
  readStoredActivity,
  reflectCloudCodeMonsterWalk,
  resolveCloudCodeMonsterPeekPosition,
  resolveCloudCodeMonsterPreviewComebackState,
  resolveCloudCodeMonsterVisibleState,
  shouldCloudCodeMonsterAutoWalk,
  shouldFaintFromMonsterShake,
  writeStoredActivity,
} from "./cloud-code-monster-pet-activity";
import { CLOUD_CODE_MONSTER_ACTIVITIES } from "./cloud-code-monster-pet-activity-data";
import {
  CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS,
  CLOUD_CODE_MONSTER_FAINT_EVENT_WINDOW_MS,
  CLOUD_CODE_MONSTER_FAINT_MS,
  CLOUD_CODE_MONSTER_PEEK_INTERVAL_MS,
  CLOUD_CODE_MONSTER_PEEK_MS,
  CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
  CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY,
  CLOUD_CODE_MONSTER_REACTION_MS,
  CLOUD_CODE_MONSTER_SHAKE_REACTION_MS,
  CLOUD_CODE_MONSTER_SIZE,
} from "./cloud-code-monster-pet-constants";
import { MonsterSvg } from "./cloud-code-monster-pet-pixel-parts";
import {
  CLOUD_CODE_MONSTER_PET_PRESETS,
  getCloudCodeMonsterPreset,
  readCloudCodeMonsterPetPresetId,
} from "./cloud-code-monster-pet-presets";
import type {
  CloudCodeMonsterActivityTriggerMode,
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
  CloudCodeMonsterActivityTriggerMode,
  CloudCodeMonsterExpression,
  CloudCodeMonsterPeekTarget,
  CloudCodeMonsterPetPreset,
  PetBounds,
  PetPoint,
  StoredCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet-types";

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

export type CloudCodeMonsterPetProps = {
  boundaryRef: RefObject<HTMLElement | null>;
  initialPosition?: PetPoint;
  activityTriggerMode?: CloudCodeMonsterActivityTriggerMode;
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
  | "walkSettle";

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
  activityTriggerMode = "global",
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
  const dragOffsetRef = useRef<PetPoint>({ x: 0, y: 0 });
  const dragStartPointRef = useRef<PetPoint | null>(null);
  const lastPointerRef = useRef<{ point: PetPoint; time: number } | null>(null);
  const lastDragDeltaRef = useRef<PetPoint | null>(null);
  const lastFootstepAtRef = useRef(0);
  const autoWalkVelocityRef = useRef<PetPoint | null>(null);
  const nextFootprintIdRef = useRef(1);
  const nextFootSideRef = useRef<"left" | "right">("left");
  const didDragRef = useRef(false);
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
      if (activityTriggerMode === "home" && document.visibilityState === "visible") {
        writeStoredActivity(
          createCloudCodeMonsterHiddenState(readStoredActivity(), Date.now())
        );
      }
    };
  }, [activityTriggerMode]);

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
              initialPosition ?? {
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

  const activity = useMemo(() => {
    if (!activityState?.activityId) {
      return null;
    }

    return CLOUD_CODE_MONSTER_ACTIVITIES.find(
      (item) => item.id === activityState.activityId
    );
  }, [activityState]);
  const preset = useMemo(() => getCloudCodeMonsterPreset(presetId), [presetId]);
  const isWalking = isDragging || isAutoWalking;
  const hasPosition = position !== null;
  const hasPeekTargets = peekTargets.length > 0;
  const shouldAutoWalk = shouldCloudCodeMonsterAutoWalk(
    activityState?.activityId ?? null
  );

  useEffect(() => {
    peekTargetsRef.current = peekTargets;
  }, [peekTargets]);

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
      isPeeking
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
      fainted
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
    reacting,
    shaken,
    setPetTimer,
  ]);

  const wakeMonsterToDefault = () => {
    setActivityState((current) => {
      if (current && !current.activityId && current.hiddenAt === null) {
        return current;
      }

      const nextState = createCloudCodeMonsterIdleState();
      writeStoredActivity(nextState);
      return nextState;
    });
  };

  const stopTemporaryMotion = () => {
    setIsAutoWalking(false);
    setIsPeeking(false);
    violentDragEventsRef.current = [];
    autoWalkVelocityRef.current = null;

    clearPetTimer("autonomousWalk");
    clearPetTimer("peek");
    clearPetTimer("peekStop");
  };

  const startShockReaction = () => {
    setReacting(true);
    setPetTimer("reaction", () => {
      setReacting(false);
    }, CLOUD_CODE_MONSTER_REACTION_MS);
  };

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
  }, [notificationToken]);

  const startShakeReaction = () => {
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
  };

  const startFaintReaction = () => {
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
  };

  const handlePetClick = () => {
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

    if (activityState?.activityId) {
      wakeMonsterToDefault();
    }

    if (fainted) {
      setFainted(false);
      clearPetTimer("faint");
    }

    startShockReaction();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
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
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
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
      now - lastFootstepAtRef.current >= getMonsterFootstepIntervalMs(intensity)
    ) {
      pushFootprint(nextPosition, intensity);
      lastFootstepAtRef.current = now;
    }
  };

  const stopDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isDragging) {
      return;
    }

    setIsDragging(false);
    violentDragEventsRef.current = [];
    dragStartPointRef.current = null;
    lastPointerRef.current = null;
    lastDragDeltaRef.current = null;

    setPetTimer("walkSettle", () => {
      setWalkIntensity(1);
    }, 180);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!position || !activityState) {
    return null;
  }

  const displayedActivity = isPeeking || fainted ? null : activity;

  return (
    <div className={styles.petLayer}>
      <div className="cloud-code-monster-pet-footsteps" aria-hidden="true">
        {footprints.map((footprint) => (
          <span
            key={footprint.id}
            className="cloud-code-monster-pet-footprint"
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
        className="cloud-code-monster-pet"
        data-activity={displayedActivity?.id ?? "idle"}
        data-dragging={isDragging}
        data-walking={isWalking}
        data-direction={walkDirection}
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
          <span className="cloud-code-monster-pet-notification-bell" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              className="cloud-code-monster-pet-notification-bell-pixel size-6"
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
          className="cloud-code-monster-pet-button"
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

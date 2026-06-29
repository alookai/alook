import {
  CLOUD_CODE_MONSTER_ACTIVITIES,
  CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS,
  CLOUD_CODE_MONSTER_WORKING_ACTIVITY_IDS,
} from "./cloud-code-monster-pet-activity-data";
import {
  CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
  CLOUD_CODE_MONSTER_AUTO_WALK_SPEED,
  CLOUD_CODE_MONSTER_FAINT_DRAG_MAX_ELAPSED_MS,
  CLOUD_CODE_MONSTER_FAINT_DRAG_MIN_DISTANCE,
  CLOUD_CODE_MONSTER_FAINT_DRAG_MIN_SPEED,
  CLOUD_CODE_MONSTER_FAINT_EVENT_WINDOW_MS,
  CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS,
  CLOUD_CODE_MONSTER_FAINT_MIN_SPAN_MS,
  CLOUD_CODE_MONSTER_FAINT_REVERSAL_MIN_SPEED,
  CLOUD_CODE_MONSTER_POSITION_STORAGE_KEY,
  CLOUD_CODE_MONSTER_SIZE,
  CLOUD_CODE_MONSTER_STORAGE_KEY,
  CLOUD_CODE_MONSTER_VIOLENT_DRAG_MAX_ELAPSED_MS,
  CLOUD_CODE_MONSTER_VIOLENT_DRAG_MIN_DISTANCE,
  CLOUD_CODE_MONSTER_VIOLENT_DRAG_MIN_SPEED,
  CLOUD_CODE_MONSTER_VIOLENT_DRAG_STRONG_DISTANCE,
  CLOUD_CODE_MONSTER_VIOLENT_REVERSAL_MIN_SPEED,
} from "./cloud-code-monster-pet-constants";
import type {
  CloudCodeMonsterActivityId,
  CloudCodeMonsterExpression,
  CloudCodeMonsterPeekTarget,
  PetBounds,
  PetPoint,
  PetSize,
  ReflectedMonsterWalk,
  StoredCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet-types";

export function clampPetPosition(
  position: PetPoint,
  bounds: PetBounds,
  size: PetSize = CLOUD_CODE_MONSTER_SIZE,
  padding = 16
) {
  const maxX = Math.max(padding, bounds.width - size.width - padding);
  const maxY = Math.max(padding, bounds.height - size.height - padding);

  return {
    x: Math.min(maxX, Math.max(padding, position.x)),
    y: Math.min(maxY, Math.max(padding, position.y)),
  };
}

function isCloudCodeMonsterActivityId(
  value: string
): value is CloudCodeMonsterActivityId {
  return CLOUD_CODE_MONSTER_ACTIVITIES.some(
    (activity) => activity.id === value
  );
}

export function shouldRefreshCloudCodeMonsterActivity(
  updatedAt: number,
  now: number,
  refreshMs = CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS
) {
  return !Number.isFinite(updatedAt) || now - updatedAt >= refreshMs;
}

export function pickCloudCodeMonsterActivity(randomValue = Math.random()) {
  const safeRandom = Number.isFinite(randomValue) ? randomValue : 0;
  const index = Math.min(
    CLOUD_CODE_MONSTER_ACTIVITIES.length - 1,
    Math.max(0, Math.floor(safeRandom * CLOUD_CODE_MONSTER_ACTIVITIES.length))
  );

  return CLOUD_CODE_MONSTER_ACTIVITIES[index]!;
}

export function shouldCloudCodeMonsterAutoWalk(
  activityId: CloudCodeMonsterActivityId | null
) {
  return (
    activityId !== null &&
    CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS.includes(activityId)
  );
}

function isCloudCodeMonsterWorkingActivity(
  activityId: CloudCodeMonsterActivityId | null
) {
  return (
    activityId !== null &&
    CLOUD_CODE_MONSTER_WORKING_ACTIVITY_IDS.includes(activityId)
  );
}

export function resolveCloudCodeMonsterAgentWorkState(
  activeTaskCount: number,
  current: StoredCloudCodeMonsterActivity | null,
  now = Date.now()
): StoredCloudCodeMonsterActivity {
  if (activeTaskCount <= 0) {
    return current?.activityId === "sleeping"
      ? current
      : createCloudCodeMonsterIdleState(now);
  }

  if (isCloudCodeMonsterWorkingActivity(current?.activityId ?? null)) {
    return {
      activityId: current!.activityId,
      updatedAt: current!.updatedAt,
      hiddenAt: null,
    };
  }

  const activityId =
    activeTaskCount >= 3 ? "building" : activeTaskCount >= 2 ? "juggling" : "coding";

  return {
    activityId,
    updatedAt: now,
    hiddenAt: null,
  };
}

export function createCloudCodeMonsterWalkVelocity(
  randomValue = Math.random(),
  speed = CLOUD_CODE_MONSTER_AUTO_WALK_SPEED
): PetPoint {
  const safeRandom = Number.isFinite(randomValue) ? randomValue : 0;
  const angle = safeRandom * Math.PI * 2;
  const x = Math.cos(angle) * speed;
  const y = Math.sin(angle) * speed;

  if (Math.abs(x) < 0.2 && Math.abs(y) < 0.2) {
    return { x: speed, y: 0 };
  }

  return { x, y };
}

export function reflectCloudCodeMonsterWalk(
  position: PetPoint,
  velocity: PetPoint,
  bounds: PetBounds,
  size = CLOUD_CODE_MONSTER_SIZE,
  padding = 16
): ReflectedMonsterWalk {
  const minX = padding;
  const minY = padding;
  const maxX = Math.max(padding, bounds.width - size.width - padding);
  const maxY = Math.max(padding, bounds.height - size.height - padding);
  let nextX = position.x + velocity.x;
  let nextY = position.y + velocity.y;
  let nextVelocityX = velocity.x;
  let nextVelocityY = velocity.y;
  let reflectedX = false;
  let reflectedY = false;

  if (nextX < minX) {
    nextX = minX + (minX - nextX);
    nextVelocityX = Math.abs(nextVelocityX);
    reflectedX = true;
  } else if (nextX > maxX) {
    nextX = maxX - (nextX - maxX);
    nextVelocityX = -Math.abs(nextVelocityX);
    reflectedX = true;
  }

  if (nextY < minY) {
    nextY = minY + (minY - nextY);
    nextVelocityY = Math.abs(nextVelocityY);
    reflectedY = true;
  } else if (nextY > maxY) {
    nextY = maxY - (nextY - maxY);
    nextVelocityY = -Math.abs(nextVelocityY);
    reflectedY = true;
  }

  return {
    position: clampPetPosition(
      { x: nextX, y: nextY },
      bounds,
      size,
      padding
    ),
    velocity: { x: nextVelocityX, y: nextVelocityY },
    reflectedX,
    reflectedY,
  };
}

export function resolveCloudCodeMonsterActivityState(
  stored: StoredCloudCodeMonsterActivity | null,
  now = Date.now()
): StoredCloudCodeMonsterActivity {
  if (
    stored &&
    stored.activityId &&
    isCloudCodeMonsterActivityId(stored.activityId) &&
    !shouldRefreshCloudCodeMonsterActivity(stored.updatedAt, now)
  ) {
    return stored;
  }

  return createCloudCodeMonsterIdleState(now);
}

export function createCloudCodeMonsterIdleState(
  now = Date.now()
): StoredCloudCodeMonsterActivity {
  return {
    activityId: null,
    updatedAt: now,
    hiddenAt: null,
  };
}

export function createCloudCodeMonsterSleepingState(
  now = Date.now()
): StoredCloudCodeMonsterActivity {
  return {
    activityId: "sleeping",
    updatedAt: now,
    hiddenAt: null,
  };
}

export function createCloudCodeMonsterHiddenState(
  current: StoredCloudCodeMonsterActivity | null,
  now = Date.now()
): StoredCloudCodeMonsterActivity {
  return {
    activityId: current?.activityId ?? null,
    updatedAt: current?.updatedAt ?? now,
    hiddenAt: now,
  };
}

export function createCloudCodeMonsterPreviewAwayState(
  now = Date.now()
): StoredCloudCodeMonsterActivity {
  const hiddenAt = now - CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS;

  return {
    activityId: null,
    updatedAt: hiddenAt,
    hiddenAt,
  };
}


export function resolveCloudCodeMonsterPreviewComebackState(
  now = Date.now()
) {
  return resolveCloudCodeMonsterVisibleState(
    createCloudCodeMonsterPreviewAwayState(now),
    now
  );
}

export function resolveCloudCodeMonsterVisibleState(
  stored: StoredCloudCodeMonsterActivity | null,
  now = Date.now()
): StoredCloudCodeMonsterActivity {
  if (stored?.hiddenAt) {
    if (shouldRefreshCloudCodeMonsterActivity(stored.hiddenAt, now)) {
      return createCloudCodeMonsterIdleState(now);
    }

    return {
      activityId: stored.activityId,
      updatedAt: stored.updatedAt,
      hiddenAt: null,
    };
  }

  if (!stored) {
    return resolveCloudCodeMonsterActivityState(stored, now);
  }

  return {
    activityId: stored.activityId,
    updatedAt: stored.updatedAt,
    hiddenAt: null,
  };
}

export function calculateMonsterWalkIntensity(
  distancePx: number,
  elapsedMs: number
) {
  if (
    !Number.isFinite(distancePx) ||
    !Number.isFinite(elapsedMs) ||
    distancePx <= 0 ||
    elapsedMs <= 0
  ) {
    return 1;
  }

  const speedPxPerMs = distancePx / elapsedMs;
  return Math.min(2.8, Math.max(0.75, 0.75 + speedPxPerMs * 2.8));
}

export function hasViolentMonsterDirectionChange(
  previousDelta: PetPoint | null,
  nextDelta: PetPoint
) {
  if (!previousDelta) {
    return false;
  }

  const previousDistance = Math.hypot(previousDelta.x, previousDelta.y);
  const nextDistance = Math.hypot(nextDelta.x, nextDelta.y);

  if (
    previousDistance < CLOUD_CODE_MONSTER_VIOLENT_DRAG_MIN_DISTANCE ||
    nextDistance < CLOUD_CODE_MONSTER_VIOLENT_DRAG_MIN_DISTANCE
  ) {
    return false;
  }

  const dotProduct =
    previousDelta.x * nextDelta.x + previousDelta.y * nextDelta.y;
  return dotProduct / (previousDistance * nextDistance) <= -0.55;
}

export function isViolentMonsterDrag(
  distancePx: number,
  elapsedMs: number,
  sharpDirectionChange = false
) {
  if (
    !Number.isFinite(distancePx) ||
    !Number.isFinite(elapsedMs) ||
    distancePx < CLOUD_CODE_MONSTER_VIOLENT_DRAG_MIN_DISTANCE ||
    elapsedMs <= 0 ||
    elapsedMs > CLOUD_CODE_MONSTER_VIOLENT_DRAG_MAX_ELAPSED_MS
  ) {
    return false;
  }

  const speedPxPerMs = distancePx / elapsedMs;
  if (sharpDirectionChange) {
    return speedPxPerMs >= CLOUD_CODE_MONSTER_VIOLENT_REVERSAL_MIN_SPEED;
  }

  return (
    distancePx >= CLOUD_CODE_MONSTER_VIOLENT_DRAG_STRONG_DISTANCE &&
    speedPxPerMs >= CLOUD_CODE_MONSTER_VIOLENT_DRAG_MIN_SPEED
  );
}

export function isMonsterFaintShakeEvent(
  distancePx: number,
  elapsedMs: number,
  sharpDirectionChange = false
) {
  if (
    !Number.isFinite(distancePx) ||
    !Number.isFinite(elapsedMs) ||
    distancePx < CLOUD_CODE_MONSTER_FAINT_DRAG_MIN_DISTANCE ||
    elapsedMs <= 0 ||
    elapsedMs > CLOUD_CODE_MONSTER_FAINT_DRAG_MAX_ELAPSED_MS
  ) {
    return false;
  }

  const speedPxPerMs = distancePx / elapsedMs;
  return sharpDirectionChange
    ? speedPxPerMs >= CLOUD_CODE_MONSTER_FAINT_REVERSAL_MIN_SPEED
    : speedPxPerMs >= CLOUD_CODE_MONSTER_FAINT_DRAG_MIN_SPEED;
}

export function shouldFaintFromMonsterShake(
  eventTimes: number[],
  now: number
) {
  const recentEvents = eventTimes.filter(
    (eventTime) => now - eventTime <= CLOUD_CODE_MONSTER_FAINT_EVENT_WINDOW_MS
  );
  const firstEvent = recentEvents[0];

  return (
    recentEvents.length >= CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS &&
    typeof firstEvent === "number" &&
    now - firstEvent >= CLOUD_CODE_MONSTER_FAINT_MIN_SPAN_MS
  );
}

export function getMonsterFootstepIntervalMs(walkIntensity: number) {
  const safeIntensity = Number.isFinite(walkIntensity)
    ? Math.min(2.8, Math.max(0.75, walkIntensity))
    : 1;

  return Math.round(260 / safeIntensity);
}

export function getCloudCodeMonsterExpression(
  activityId: CloudCodeMonsterActivityId | null,
  reacting: boolean,
  shaken: boolean,
  fainted = false
): CloudCodeMonsterExpression {
  if (fainted) {
    return "fainted";
  }

  if (shaken) {
    return "shaken";
  }

  if (reacting) {
    return "shocked";
  }

  if (activityId === "sleeping" || activityId === "dozing" || activityId === "yawning") {
    return "sleeping";
  }

  return "idle";
}

export function readStoredActivity(): StoredCloudCodeMonsterActivity | null {
  try {
    const raw = localStorage.getItem(CLOUD_CODE_MONSTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCloudCodeMonsterActivity>;
    if (
      typeof parsed.activityId === "string" &&
      isCloudCodeMonsterActivityId(parsed.activityId) &&
      typeof parsed.updatedAt === "number"
    ) {
      return {
        activityId: parsed.activityId,
        updatedAt: parsed.updatedAt,
        hiddenAt:
          typeof parsed.hiddenAt === "number" && Number.isFinite(parsed.hiddenAt)
            ? parsed.hiddenAt
            : null,
      };
    }
    if (parsed.activityId === null && typeof parsed.updatedAt === "number") {
      return {
        activityId: null,
        updatedAt: parsed.updatedAt,
        hiddenAt:
          typeof parsed.hiddenAt === "number" && Number.isFinite(parsed.hiddenAt)
            ? parsed.hiddenAt
            : null,
      };
    }
  } catch {}

  return null;
}

export function writeStoredActivity(activityState: StoredCloudCodeMonsterActivity) {
  try {
    localStorage.setItem(
      CLOUD_CODE_MONSTER_STORAGE_KEY,
      JSON.stringify(activityState)
    );
  } catch {}
}

export function readStoredPosition(): PetPoint | null {
  try {
    const raw = localStorage.getItem(CLOUD_CODE_MONSTER_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      return { x: parsed.x, y: parsed.y };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeStoredPosition(position: PetPoint) {
  try {
    localStorage.setItem(
      CLOUD_CODE_MONSTER_POSITION_STORAGE_KEY,
      JSON.stringify({ x: position.x, y: position.y })
    );
  } catch {}
}

export function createWalkToTargetVelocity(
  from: PetPoint,
  to: PetPoint,
  speed: number
): PetPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  if (!Number.isFinite(distance) || distance < 0.01) {
    return { x: 0, y: 0 };
  }

  return { x: (dx / distance) * speed, y: (dy / distance) * speed };
}

export function getBounds(_boundary: HTMLElement | null): PetBounds {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function findAgentPeekNode(
  boundary: HTMLElement | null,
  agentId: string
): HTMLElement | null {
  if (!boundary) {
    return null;
  }

  return (
    Array.from(
      boundary.querySelectorAll<HTMLElement>("[data-agent-node-id]")
    ).find((node) => node.dataset.agentNodeId === agentId) ?? null
  );
}

export function resolveCloudCodeMonsterPeekPosition(
  target: CloudCodeMonsterPeekTarget,
  boundary: HTMLElement | null,
  bounds: PetBounds
): PetPoint {
  if (target.agentId) {
    const agentNode = findAgentPeekNode(boundary, target.agentId);
    const agentRect = agentNode?.getBoundingClientRect();

    if (agentRect) {
      return clampPetPosition(
        {
          x:
            agentRect.left +
            agentRect.width / 2 -
            CLOUD_CODE_MONSTER_SIZE.width / 2,
          y:
            agentRect.top -
            CLOUD_CODE_MONSTER_SIZE.height * 0.18,
        },
        bounds,
        CLOUD_CODE_MONSTER_SIZE
      );
    }
  }

  return clampPetPosition(
    {
      x: target.x - CLOUD_CODE_MONSTER_SIZE.width / 2,
      y: target.y - CLOUD_CODE_MONSTER_SIZE.height + 20,
    },
    bounds,
    CLOUD_CODE_MONSTER_SIZE
  );
}

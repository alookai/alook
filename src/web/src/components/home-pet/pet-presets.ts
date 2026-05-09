export type PetSceneKind = "ambient" | "reaction";

export type PetSceneName = string;

export type PetScene = {
  name: PetSceneName;
  label: string;
  kind: PetSceneKind;
  statusText: string;
  animationClass: string;
  spriteAnimation: PetSpriteAnimation;
  asset?: PetSpriteAsset;
  returnTo?: PetSceneName;
};

export type PetSpriteAnimation = {
  row: number;
  frames: number;
  frameDurations: readonly number[];
  restDurationMs?: readonly [number, number];
};

export type PetSpriteAsset = {
  src: string;
  alt: string;
};

export type PetPreset = {
  id: string;
  displayName: string;
  description: string;
  sprite: PetSpriteAsset;
  homeScene: PetSceneName;
  reactionScene?: PetSceneName;
  scenes: Record<PetSceneName, PetScene>;
};

export type PetPoint = {
  x: number;
  y: number;
};

export type PetBounds = {
  width: number;
  height: number;
};

export type PetSize = {
  width: number;
  height: number;
};

export const HOME_PET_SIZE: PetSize = {
  width: 72,
  height: 78,
};

export const HOME_PET_ATLAS = {
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208,
} as const;

export const HOME_PET_REACTION_MS = 900;
export const HOME_PET_FRAME_REST_MS = [5600, 12800] as const;

export const HOME_PET_PRESETS: PetPreset[] = [
  {
    id: "tater",
    displayName: "Tater",
    description:
      "A cheerful potato mascot with visor goggles and chunky futuristic sneakers.",
    sprite: {
      src: "/pets/tater/spritesheet.webp",
      alt: "Tater, the Alook workspace PET",
    },
    homeScene: "idle",
    reactionScene: "startled",
    scenes: {
      idle: {
        name: "idle",
        label: "Idle",
        kind: "ambient",
        statusText: "keeping the workspace warm",
        animationClass: "home-pet-motion-idle",
        spriteAnimation: {
          row: 0,
          frames: 6,
          frameDurations: [520, 120, 110, 130, 120, 180],
          restDurationMs: HOME_PET_FRAME_REST_MS,
        },
      },
      watching: {
        name: "watching",
        label: "Watching",
        kind: "ambient",
        statusText: "watching the agents wake up",
        animationClass: "home-pet-motion-watch",
        spriteAnimation: {
          row: 8,
          frames: 6,
          frameDurations: [220, 120, 120, 130, 130, 180],
          restDurationMs: HOME_PET_FRAME_REST_MS,
        },
      },
      scrolling: {
        name: "scrolling",
        label: "Scrolling",
        kind: "ambient",
        statusText: "checking the latest task cards",
        animationClass: "home-pet-motion-scroll",
        spriteAnimation: {
          row: 6,
          frames: 6,
          frameDurations: [240, 120, 120, 125, 125, 180],
          restDurationMs: HOME_PET_FRAME_REST_MS,
        },
      },
      napping: {
        name: "napping",
        label: "Napping",
        kind: "ambient",
        statusText: "taking a tiny systems nap",
        animationClass: "home-pet-motion-nap",
        spriteAnimation: {
          row: 5,
          frames: 8,
          frameDurations: [420, 130, 130, 130, 130, 130, 130, 220],
          restDurationMs: [7200, 14800],
        },
      },
      thinking: {
        name: "thinking",
        label: "Thinking",
        kind: "ambient",
        statusText: "thinking through a handoff",
        animationClass: "home-pet-motion-think",
        spriteAnimation: {
          row: 3,
          frames: 4,
          frameDurations: [260, 130, 130, 220],
          restDurationMs: [6200, 13200],
        },
      },
      startled: {
        name: "startled",
        label: "Noticed",
        kind: "reaction",
        statusText: "noticed you",
        animationClass: "home-pet-motion-startled",
        spriteAnimation: {
          row: 4,
          frames: 5,
          frameDurations: [140, 140, 140, 140, 280],
        },
        returnTo: "idle",
      },
    },
  },
];

export function getPetPreset(presetId = "tater") {
  return (
    HOME_PET_PRESETS.find((preset) => preset.id === presetId) ??
    HOME_PET_PRESETS[0]
  );
}

export function getAmbientScenes(preset: PetPreset) {
  return Object.values(preset.scenes).filter(
    (scene) => scene.kind === "ambient"
  );
}

export function selectAmbientScene(
  preset: PetPreset,
  randomValue = Math.random()
) {
  const ambientScenes = getAmbientScenes(preset);
  const safeRandomValue = Number.isFinite(randomValue) ? randomValue : 0;
  const index = Math.min(
    ambientScenes.length - 1,
    Math.max(0, Math.floor(safeRandomValue * ambientScenes.length))
  );

  return ambientScenes[index] ?? preset.scenes[preset.homeScene];
}

export function selectNextAmbientScene(
  preset: PetPreset,
  previousSceneName: PetSceneName,
  randomValue = Math.random()
) {
  const homeScene = preset.scenes[preset.homeScene];

  if (previousSceneName !== preset.homeScene) {
    return homeScene;
  }

  const burstScenes = getAmbientScenes(preset).filter(
    (scene) => scene.name !== preset.homeScene
  );

  if (burstScenes.length === 0) {
    return homeScene;
  }

  const safeRandomValue = Number.isFinite(randomValue) ? randomValue : 0;

  if (safeRandomValue < 0.68) {
    return homeScene;
  }

  const burstRandom = (safeRandomValue - 0.68) / 0.32;
  const index = Math.min(
    burstScenes.length - 1,
    Math.max(0, Math.floor(burstRandom * burstScenes.length))
  );

  return burstScenes[index] ?? homeScene;
}

export function getReactionReturnScene(
  preset: PetPreset,
  previousSceneName: PetSceneName
) {
  const previousScene = preset.scenes[previousSceneName];

  if (previousScene?.kind === "ambient") {
    return previousScene;
  }

  return preset.scenes[previousScene?.returnTo ?? preset.homeScene];
}

export function getReactionScene(preset: PetPreset) {
  const configuredScene = preset.reactionScene
    ? preset.scenes[preset.reactionScene]
    : undefined;

  if (configuredScene?.kind === "reaction") {
    return configuredScene;
  }

  return Object.values(preset.scenes).find(
    (scene) => scene.kind === "reaction"
  );
}

export function clampPetPosition(
  position: PetPoint,
  bounds: PetBounds,
  size: PetSize = HOME_PET_SIZE,
  padding = 16
) {
  const maxX = Math.max(padding, bounds.width - size.width - padding);
  const maxY = Math.max(padding, bounds.height - size.height - padding);

  return {
    x: Math.min(maxX, Math.max(padding, position.x)),
    y: Math.min(maxY, Math.max(padding, position.y)),
  };
}

export function getDefaultPetPosition(bounds: PetBounds) {
  return clampPetPosition(
    {
      x: bounds.width - HOME_PET_SIZE.width - 64,
      y: Math.min(bounds.height * 0.44, bounds.height - HOME_PET_SIZE.height - 112),
    },
    bounds
  );
}

export function getSpriteFrameDelay(
  scene: PetScene,
  spriteFrame: number,
  randomValue = Math.random()
) {
  const animation = scene.spriteAnimation;
  const isRestingFrame = spriteFrame === 0;

  if (scene.kind === "ambient" && isRestingFrame && animation.restDurationMs) {
    const [minRest, maxRest] = animation.restDurationMs;
    const safeRandomValue = Number.isFinite(randomValue) ? randomValue : 0;
    return minRest + Math.round((maxRest - minRest) * safeRandomValue);
  }

  return (
    animation.frameDurations[spriteFrame] ??
    animation.frameDurations[animation.frameDurations.length - 1] ??
    150
  );
}

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

export type CloudCodeMonsterPeekTarget = PetPoint & {
  agentId?: string;
};

export type CloudCodeMonsterActivityId =
  | "coding"
  | "sleeping"
  | "reading"
  | "phone"
  | "thinking"
  | "snacking";

export type CloudCodeMonsterActivity = {
  id: CloudCodeMonsterActivityId;
  label: string;
  caption: string;
};

type CloudCodeMonsterPresetFeature =
  | "square"
  | "horns"
  | "ears"
  | "visor"
  | "antenna"
  | "crown"
  | "bell"
  | "bolt"
  | "star"
  | "leaf"
  | "flame"
  | "fins"
  | "moon"
  | "mushroom"
  | "spin"
  | "chomp"
  | "ghost"
  | "cap"
  | "bow"
  | "hood"
  | "mask"
  | "soot"
  | "straw"
  | "ninja"
  | "pearl"
  | "wand"
  | "mecha"
  | "slime"
  | "ink"
  | "drum"
  | "sprout";

type CloudCodeMonsterPresetShape =
  | "monster"
  | "gadget-buddy"
  | "electric-mascot"
  | "star-puff"
  | "leaf-bud-shape"
  | "ember-scout"
  | "shell-sprout"
  | "block-builder-shape"
  | "block-hiss-shape"
  | "block-walker-shape"
  | "mushroom-pal-shape"
  | "blue-spinner"
  | "arcade-chomper"
  | "peek-ghost-shape"
  | "cap-jumper"
  | "honey-cub-shape"
  | "ribbon-cat-shape"
  | "cozy-hood-bunny-shape"
  | "imp-hood-shape"
  | "forest-neighbor-shape"
  | "dust-puff-shape"
  | "straw-voyager-shape"
  | "leaf-runner-shape"
  | "energy-pearl-shape"
  | "moon-wand-shape"
  | "mecha-guard-shape"
  | "teardrop-slime-shape"
  | "ink-runner-shape"
  | "little-beagle-shape"
  | "tiny-antler-shape";

export type CloudCodeMonsterPetPreset = {
  id: string;
  name: string;
  group: string;
  feature: CloudCodeMonsterPresetFeature;
  shape?: CloudCodeMonsterPresetShape;
  bodyTop: string;
  body: string;
  bodyDark: string;
  bodyLight: string;
  bodySideLight: string;
  bodySideDark: string;
  accent: string;
  accessory: string;
  eye: string;
  highlight: string;
  facePatch?: string;
  cheek?: string;
};

export type StoredCloudCodeMonsterActivity = {
  activityId: CloudCodeMonsterActivityId | null;
  updatedAt: number;
  hiddenAt: number | null;
};

export type CloudCodeMonsterExpression =
  | "idle"
  | "sleeping"
  | "shocked"
  | "shaken"
  | "fainted";

export type Footprint = {
  id: number;
  x: number;
  y: number;
  side: "left" | "right";
  intensity: number;
};

export type ReflectedMonsterWalk = {
  position: PetPoint;
  velocity: PetPoint;
  reflectedX: boolean;
  reflectedY: boolean;
};

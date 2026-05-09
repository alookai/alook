"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clampPetPosition, type PetBounds, type PetPoint } from "./pet-presets";

export const CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS = 3 * 60 * 1000;
const CLOUD_CODE_MONSTER_STORAGE_KEY = "alook-cloud-code-monster-pet-activity-v1";
export const CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY =
  "alook-cloud-code-monster-pet-preset-v1";
export const CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT =
  "alook-cloud-code-monster-pet-preset-changed";
const CLOUD_CODE_MONSTER_REACTION_MS = 900;
const CLOUD_CODE_MONSTER_SHAKE_REACTION_MS = 680;
export const CLOUD_CODE_MONSTER_FAINT_MS = 10_000;
const CLOUD_CODE_MONSTER_VIOLENT_DRAG_MIN_DISTANCE = 24;
const CLOUD_CODE_MONSTER_VIOLENT_DRAG_STRONG_DISTANCE = 56;
const CLOUD_CODE_MONSTER_VIOLENT_DRAG_MAX_ELAPSED_MS = 70;
const CLOUD_CODE_MONSTER_VIOLENT_DRAG_MIN_SPEED = 1.2;
const CLOUD_CODE_MONSTER_VIOLENT_REVERSAL_MIN_SPEED = 1.5;
const CLOUD_CODE_MONSTER_FAINT_DRAG_MIN_DISTANCE = 72;
const CLOUD_CODE_MONSTER_FAINT_DRAG_MAX_ELAPSED_MS = 55;
const CLOUD_CODE_MONSTER_FAINT_DRAG_MIN_SPEED = 2.2;
const CLOUD_CODE_MONSTER_FAINT_REVERSAL_MIN_SPEED = 2.75;
export const CLOUD_CODE_MONSTER_FAINT_EVENT_WINDOW_MS = 1_300;
export const CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS = 6;
export const CLOUD_CODE_MONSTER_FAINT_MIN_SPAN_MS = 450;
const CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS = 80;
const CLOUD_CODE_MONSTER_AUTO_WALK_SPEED = 2.7;
const CLOUD_CODE_MONSTER_PEEK_MS = 4_200;
const CLOUD_CODE_MONSTER_PEEK_INTERVAL_MS = 11_000;
const CLOUD_CODE_MONSTER_SIZE = { width: 82, height: 82 };

export type CloudCodeMonsterPeekTarget = PetPoint & {
  agentId?: string;
};

export type CloudCodeMonsterActivityTriggerMode = "home" | "global";

export type CloudCodeMonsterActivityId =
  | "coding"
  | "sleeping"
  | "reading"
  | "phone"
  | "thinking"
  | "snacking";

type CloudCodeMonsterActivity = {
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
  | "doraemon"
  | "pikachu"
  | "kirby"
  | "bulbasaur"
  | "charmander"
  | "squirtle"
  | "minecraft-steve"
  | "minecraft-creeper"
  | "minecraft-zombie"
  | "toad"
  | "sonic"
  | "pacman"
  | "boo"
  | "mario"
  | "pooh"
  | "hello-kitty"
  | "my-melody"
  | "kuromi"
  | "totoro"
  | "soot-sprite"
  | "luffy"
  | "naruto"
  | "goku"
  | "sailor-moon"
  | "gundam"
  | "dragon-quest-slime"
  | "inkling"
  | "snoopy"
  | "chopper";

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

type Footprint = {
  id: number;
  x: number;
  y: number;
  side: "left" | "right";
  intensity: number;
};

type ReflectedMonsterWalk = {
  position: PetPoint;
  velocity: PetPoint;
  reflectedX: boolean;
  reflectedY: boolean;
};

export const CLOUD_CODE_MONSTER_ACTIVITIES: CloudCodeMonsterActivity[] = [
  { id: "coding", label: "写代码", caption: "在敲一段小 patch" },
  { id: "sleeping", label: "睡觉", caption: "闭眼打盹" },
  { id: "reading", label: "看书", caption: "翻一本很厚的 docs" },
  { id: "phone", label: "玩手机", caption: "盯着小屏幕发光" },
  { id: "thinking", label: "发呆", caption: "处理一点后台思考" },
  { id: "snacking", label: "吃零食", caption: "嚼一点能量块" },
];

export const CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS: readonly CloudCodeMonsterActivityId[] = [
  "reading",
  "phone",
  "snacking",
];

const CLOUD_CODE_MONSTER_PET_PRESET_BASES: CloudCodeMonsterPetPreset[] = [
  {
    id: "pet-01",
    name: "Claude Pixel",
    group: "Codex",
    feature: "square",
    bodyTop: "#e0845f",
    body: "#d87352",
    bodyDark: "#cf684a",
    bodyLight: "#e88d68",
    bodySideLight: "#df7d5a",
    bodySideDark: "#c86347",
    accent: "#d7654a",
    accessory: "#f1bc62",
    eye: "#12100f",
    highlight: "#f6e7d7",
  },
  {
    id: "pet-02",
    name: "Blue Pocket Bot",
    group: "Gadget Buddy",
    feature: "bell",
    bodyTop: "#4aa8d8",
    body: "#2f8fc4",
    bodyDark: "#2674a4",
    bodyLight: "#68bce5",
    bodySideLight: "#48a8d5",
    bodySideDark: "#1f6591",
    accent: "#d84e4a",
    accessory: "#f4c94f",
    eye: "#10141a",
    highlight: "#f7fbff",
    facePatch: "#f6fbff",
    cheek: "#d84e4a",
  },
  {
    id: "pet-03",
    name: "Spark Arcade Pal",
    group: "Electric Mascot",
    feature: "bolt",
    bodyTop: "#f2d45a",
    body: "#e6bd37",
    bodyDark: "#c89a2a",
    bodyLight: "#ffe37a",
    bodySideLight: "#f0cc4c",
    bodySideDark: "#b58724",
    accent: "#2f2520",
    accessory: "#df5145",
    eye: "#17120e",
    highlight: "#fff7c7",
    cheek: "#e94d43",
  },
  {
    id: "pet-04",
    name: "Pink Star Puff",
    group: "Star Puff",
    feature: "star",
    bodyTop: "#eba0b7",
    body: "#df7fa0",
    bodyDark: "#c76589",
    bodyLight: "#f2b6c8",
    bodySideLight: "#e993ac",
    bodySideDark: "#b95778",
    accent: "#c84d64",
    accessory: "#f0d862",
    eye: "#171016",
    highlight: "#fff0f6",
    cheek: "#e75c7a",
  },
  {
    id: "pet-05",
    name: "Leaf Sprite",
    group: "Forest Starter",
    feature: "leaf",
    bodyTop: "#76aa7b",
    body: "#5f9666",
    bodyDark: "#4d7c54",
    bodyLight: "#91bd8f",
    bodySideLight: "#72a875",
    bodySideDark: "#426d49",
    accent: "#2f6f46",
    accessory: "#d6e78a",
    eye: "#11160f",
    highlight: "#f0f8e4",
    facePatch: "#dceec2",
  },
  {
    id: "pet-06",
    name: "Ember Starter",
    group: "Fire Buddy",
    feature: "flame",
    bodyTop: "#df8755",
    body: "#ce6b3f",
    bodyDark: "#af5333",
    bodyLight: "#ee9d6b",
    bodySideLight: "#dd7b4c",
    bodySideDark: "#9a482c",
    accent: "#8d3d2f",
    accessory: "#f3c34b",
    eye: "#17100c",
    highlight: "#ffe8d4",
    cheek: "#e45842",
  },
  {
    id: "pet-07",
    name: "Ripple Buddy",
    group: "Water Buddy",
    feature: "fins",
    bodyTop: "#82b5d6",
    body: "#629dcc",
    bodyDark: "#4f82ad",
    bodyLight: "#9bc8e5",
    bodySideLight: "#73add6",
    bodySideDark: "#44749b",
    accent: "#5f6f8d",
    accessory: "#ead59a",
    eye: "#10151b",
    highlight: "#eff8ff",
    facePatch: "#d9eef8",
  },
  {
    id: "pet-08",
    name: "Moon Alley Cat",
    group: "Moon Cat",
    feature: "moon",
    bodyTop: "#4f4b69",
    body: "#3f3a59",
    bodyDark: "#332f49",
    bodyLight: "#67607e",
    bodySideLight: "#554f6d",
    bodySideDark: "#2b283e",
    accent: "#e5c85c",
    accessory: "#d66f91",
    eye: "#f5e8a7",
    highlight: "#fff6c8",
    cheek: "#cf6d8f",
  },
  {
    id: "pet-09",
    name: "Spore Runner",
    group: "Mushroom Runner",
    feature: "mushroom",
    bodyTop: "#e0524f",
    body: "#f0dcc6",
    bodyDark: "#d7c0aa",
    bodyLight: "#f7ead9",
    bodySideLight: "#f1dfcb",
    bodySideDark: "#c7aa95",
    accent: "#b83736",
    accessory: "#ffffff",
    eye: "#17120f",
    highlight: "#fff8ea",
  },
  {
    id: "pet-10",
    name: "Dash Quill",
    group: "Speed Mascot",
    feature: "spin",
    bodyTop: "#4e83d0",
    body: "#356dbd",
    bodyDark: "#2a579b",
    bodyLight: "#6896de",
    bodySideLight: "#477dd0",
    bodySideDark: "#244c88",
    accent: "#f2c45b",
    accessory: "#f2ece1",
    eye: "#10131a",
    highlight: "#eef4ff",
    facePatch: "#ead3b9",
  },
  {
    id: "pet-11",
    name: "Lemon Chomper",
    group: "Arcade Chomper",
    feature: "chomp",
    bodyTop: "#f0ce45",
    body: "#e5ba2f",
    bodyDark: "#c89924",
    bodyLight: "#ffe26c",
    bodySideLight: "#efc73f",
    bodySideDark: "#b18520",
    accent: "#1f1b18",
    accessory: "#f2845f",
    eye: "#15110d",
    highlight: "#fff2b6",
  },
  {
    id: "pet-12",
    name: "Lantern Ghost",
    group: "Round Ghost",
    feature: "ghost",
    bodyTop: "#d9dff0",
    body: "#c4cee6",
    bodyDark: "#aab6d2",
    bodyLight: "#edf2ff",
    bodySideLight: "#d3dced",
    bodySideDark: "#9aa8c6",
    accent: "#6d7da8",
    accessory: "#e77c9c",
    eye: "#151926",
    highlight: "#ffffff",
  },
  {
    id: "pet-13",
    name: "Red Cap Jumper",
    group: "Platform Pal",
    feature: "cap",
    bodyTop: "#d84f45",
    body: "#c5a17d",
    bodyDark: "#a98263",
    bodyLight: "#e0ba94",
    bodySideLight: "#d3ad86",
    bodySideDark: "#936f54",
    accent: "#2c4f99",
    accessory: "#f6e9d1",
    eye: "#16110d",
    highlight: "#fff2df",
  },
  {
    id: "pet-14",
    name: "Honey Cub",
    group: "Classic Toy",
    feature: "ears",
    bodyTop: "#e4b25a",
    body: "#d0993e",
    bodyDark: "#ad7d30",
    bodyLight: "#efc46d",
    bodySideLight: "#dba84d",
    bodySideDark: "#996d2a",
    accent: "#b54d3f",
    accessory: "#f4d991",
    eye: "#17110d",
    highlight: "#fff0c8",
    facePatch: "#f2d083",
  },
  {
    id: "pet-15",
    name: "Ribbon Puff",
    group: "Bow Buddy",
    feature: "bow",
    bodyTop: "#f2f0e8",
    body: "#e3ded4",
    bodyDark: "#c9c2b7",
    bodyLight: "#ffffff",
    bodySideLight: "#eee9df",
    bodySideDark: "#bab2a7",
    accent: "#d84b5b",
    accessory: "#f3cc56",
    eye: "#15110f",
    highlight: "#ffffff",
    cheek: "#df6d80",
  },
  {
    id: "pet-16",
    name: "Cozy Hood Cub",
    group: "Hooded Mascot",
    feature: "hood",
    bodyTop: "#ef9eba",
    body: "#e681a4",
    bodyDark: "#c96789",
    bodyLight: "#f5b6ca",
    bodySideLight: "#ee94b2",
    bodySideDark: "#b85878",
    accent: "#f0d6de",
    accessory: "#f3d66b",
    eye: "#171017",
    highlight: "#fff0f6",
    facePatch: "#fff6f2",
  },
  {
    id: "pet-17",
    name: "Masked Beetle",
    group: "Bug Hero",
    feature: "mask",
    bodyTop: "#6e617d",
    body: "#554761",
    bodyDark: "#41374b",
    bodyLight: "#837491",
    bodySideLight: "#655570",
    bodySideDark: "#382f41",
    accent: "#cf6f8e",
    accessory: "#f0d46a",
    eye: "#f7edf4",
    highlight: "#fff7ff",
    facePatch: "#ece0ea",
  },
  {
    id: "pet-18",
    name: "Round Forest Pal",
    group: "Forest Neighbor",
    feature: "ears",
    bodyTop: "#8c8d7d",
    body: "#74766a",
    bodyDark: "#606257",
    bodyLight: "#a0a293",
    bodySideLight: "#838578",
    bodySideDark: "#55574d",
    accent: "#d9d3b8",
    accessory: "#c6d68c",
    eye: "#121411",
    highlight: "#efead8",
    facePatch: "#dad4ba",
  },
  {
    id: "pet-19",
    name: "Soot Sprite",
    group: "Tiny Soot",
    feature: "soot",
    bodyTop: "#34343a",
    body: "#25262c",
    bodyDark: "#1d1e24",
    bodyLight: "#4a4b52",
    bodySideLight: "#383941",
    bodySideDark: "#171820",
    accent: "#6c6f7a",
    accessory: "#f0f0d8",
    eye: "#f7f7e8",
    highlight: "#ffffff",
  },
  {
    id: "pet-20",
    name: "Straw Field Pal",
    group: "Harvest Buddy",
    feature: "straw",
    bodyTop: "#d96a50",
    body: "#c65342",
    bodyDark: "#a74336",
    bodyLight: "#e47d64",
    bodySideLight: "#d0614d",
    bodySideDark: "#933a30",
    accent: "#2f5f93",
    accessory: "#e8c866",
    eye: "#15100d",
    highlight: "#ffe6d9",
  },
  {
    id: "pet-21",
    name: "Shadow Ninja Bean",
    group: "Ninja Mascot",
    feature: "ninja",
    bodyTop: "#e7a04d",
    body: "#d88432",
    bodyDark: "#b96c27",
    bodyLight: "#efb464",
    bodySideLight: "#df943e",
    bodySideDark: "#a25d22",
    accent: "#2d415c",
    accessory: "#ded5c6",
    eye: "#15100c",
    highlight: "#ffe7c8",
    facePatch: "#f3c78d",
  },
  {
    id: "pet-22",
    name: "Pearl Quest Cub",
    group: "Pearl Hero",
    feature: "pearl",
    bodyTop: "#e3a54e",
    body: "#ce8438",
    bodyDark: "#ac682e",
    bodyLight: "#efbc68",
    bodySideLight: "#db9345",
    bodySideDark: "#985a28",
    accent: "#476ca6",
    accessory: "#f0d464",
    eye: "#15100c",
    highlight: "#ffe8c4",
  },
  {
    id: "pet-23",
    name: "Wand Starling",
    group: "Magic Mascot",
    feature: "wand",
    bodyTop: "#f0a6c4",
    body: "#df87ad",
    bodyDark: "#c26b92",
    bodyLight: "#f5bad2",
    bodySideLight: "#e99ab9",
    bodySideDark: "#ad5d82",
    accent: "#d8b34a",
    accessory: "#e9d7ff",
    eye: "#171017",
    highlight: "#fff0f7",
    cheek: "#e76791",
  },
  {
    id: "pet-24",
    name: "Mecha Bean",
    group: "Tiny Mecha",
    feature: "mecha",
    bodyTop: "#d7dbe2",
    body: "#bdc3ce",
    bodyDark: "#9ea6b3",
    bodyLight: "#edf0f5",
    bodySideLight: "#cbd1da",
    bodySideDark: "#8d96a5",
    accent: "#d44d4a",
    accessory: "#f0c748",
    eye: "#151923",
    highlight: "#ffffff",
  },
  {
    id: "pet-25",
    name: "Bubble Slimelet",
    group: "Slime Buddy",
    feature: "slime",
    bodyTop: "#79b8e8",
    body: "#5aa0d8",
    bodyDark: "#4384ba",
    bodyLight: "#96cdf0",
    bodySideLight: "#70b3e3",
    bodySideDark: "#3975a6",
    accent: "#2a658f",
    accessory: "#f3f7ff",
    eye: "#101722",
    highlight: "#f5fbff",
  },
  {
    id: "pet-26",
    name: "Ink Courier",
    group: "Ink Runner",
    feature: "ink",
    bodyTop: "#75c8bb",
    body: "#54afa2",
    bodyDark: "#3f9188",
    bodyLight: "#90d9ce",
    bodySideLight: "#67c1b5",
    bodySideDark: "#377f77",
    accent: "#d7668f",
    accessory: "#e4f2ef",
    eye: "#101716",
    highlight: "#effffb",
  },
  {
    id: "pet-27",
    name: "Drum Marcher",
    group: "Rhythm Pal",
    feature: "drum",
    bodyTop: "#ef7f5f",
    body: "#df6349",
    bodyDark: "#bd4d3b",
    bodyLight: "#f39a7b",
    bodySideLight: "#e77358",
    bodySideDark: "#a84434",
    accent: "#4f78b6",
    accessory: "#f3e4c6",
    eye: "#15100d",
    highlight: "#fff0e4",
  },
  {
    id: "pet-28",
    name: "Sprout Forestling",
    group: "Sprout Buddy",
    feature: "sprout",
    bodyTop: "#a58f5d",
    body: "#8f7548",
    bodyDark: "#755f3a",
    bodyLight: "#b9a26e",
    bodySideLight: "#9b8354",
    bodySideDark: "#655233",
    accent: "#5d8b56",
    accessory: "#dfc86e",
    eye: "#15110c",
    highlight: "#f8ecc0",
    facePatch: "#d8be71",
  },
  {
    id: "pet-29",
    name: "Frost Star Pup",
    group: "Ice Pal",
    feature: "star",
    bodyTop: "#8aa7d8",
    body: "#6e91c8",
    bodyDark: "#5877aa",
    bodyLight: "#a1bce5",
    bodySideLight: "#7f9fd3",
    bodySideDark: "#4e6898",
    accent: "#f0cf5b",
    accessory: "#f3edf5",
    eye: "#10151c",
    highlight: "#eff5ff",
    cheek: "#d66d86",
  },
  {
    id: "pet-30",
    name: "Tiny Quest Cub",
    group: "Quest Mascot",
    feature: "bow",
    bodyTop: "#efa2c8",
    body: "#df84b2",
    bodyDark: "#c46999",
    bodyLight: "#f5b9d5",
    bodySideLight: "#eb96c2",
    bodySideDark: "#ad5a86",
    accent: "#cf4d78",
    accessory: "#f0d66a",
    eye: "#171016",
    highlight: "#fff0f8",
    cheek: "#df688f",
  },
];

const LICENSED_IP_PRESET_OVERRIDES = [
  { id: "pet-02", name: "Doraemon", group: "Licensed IP", feature: "bell", shape: "doraemon" },
  { id: "pet-03", name: "Pikachu", group: "Licensed IP", feature: "bolt", shape: "pikachu" },
  { id: "pet-04", name: "Kirby", group: "Licensed IP", feature: "star", shape: "kirby" },
  { id: "pet-05", name: "Bulbasaur", group: "Licensed IP", feature: "leaf", shape: "bulbasaur" },
  { id: "pet-06", name: "Charmander", group: "Licensed IP", feature: "flame", shape: "charmander" },
  { id: "pet-07", name: "Squirtle", group: "Licensed IP", feature: "fins", shape: "squirtle" },
  { id: "pet-08", name: "Minecraft Steve", group: "Licensed IP", feature: "visor", shape: "minecraft-steve" },
  { id: "pet-09", name: "Minecraft Creeper", group: "Licensed IP", feature: "mask", shape: "minecraft-creeper" },
  { id: "pet-10", name: "Minecraft Zombie", group: "Licensed IP", feature: "visor", shape: "minecraft-zombie" },
  { id: "pet-11", name: "Toad", group: "Licensed IP", feature: "mushroom", shape: "toad" },
  { id: "pet-12", name: "Sonic", group: "Licensed IP", feature: "spin", shape: "sonic" },
  { id: "pet-13", name: "Pac-Man", group: "Licensed IP", feature: "chomp", shape: "pacman" },
  { id: "pet-14", name: "Boo", group: "Licensed IP", feature: "ghost", shape: "boo" },
  { id: "pet-15", name: "Mario", group: "Licensed IP", feature: "cap", shape: "mario" },
  { id: "pet-16", name: "Winnie the Pooh", group: "Licensed IP", feature: "ears", shape: "pooh" },
  { id: "pet-17", name: "Hello Kitty", group: "Licensed IP", feature: "bow", shape: "hello-kitty" },
  { id: "pet-18", name: "My Melody", group: "Licensed IP", feature: "hood", shape: "my-melody" },
  { id: "pet-19", name: "Kuromi", group: "Licensed IP", feature: "mask", shape: "kuromi" },
  { id: "pet-20", name: "Totoro", group: "Licensed IP", feature: "ears", shape: "totoro" },
  { id: "pet-21", name: "Soot Sprite", group: "Licensed IP", feature: "soot", shape: "soot-sprite" },
  { id: "pet-22", name: "Luffy", group: "Licensed IP", feature: "straw", shape: "luffy" },
  { id: "pet-23", name: "Naruto", group: "Licensed IP", feature: "ninja", shape: "naruto" },
  { id: "pet-24", name: "Goku", group: "Licensed IP", feature: "pearl", shape: "goku" },
  { id: "pet-25", name: "Sailor Moon", group: "Licensed IP", feature: "wand", shape: "sailor-moon" },
  { id: "pet-26", name: "Gundam", group: "Licensed IP", feature: "mecha", shape: "gundam" },
  { id: "pet-27", name: "Dragon Quest Slime", group: "Licensed IP", feature: "slime", shape: "dragon-quest-slime" },
  { id: "pet-28", name: "Inkling", group: "Licensed IP", feature: "ink", shape: "inkling" },
  { id: "pet-29", name: "Snoopy", group: "Licensed IP", feature: "ears", shape: "snoopy" },
  { id: "pet-30", name: "Chopper", group: "Licensed IP", feature: "horns", shape: "chopper" },
] satisfies Array<
  Pick<CloudCodeMonsterPetPreset, "id" | "name" | "group" | "feature" | "shape">
>;

const LICENSED_IP_PRESET_OVERRIDE_BY_ID = new Map(
  LICENSED_IP_PRESET_OVERRIDES.map((preset) => [preset.id, preset])
);

export const CLOUD_CODE_MONSTER_PET_PRESETS: CloudCodeMonsterPetPreset[] =
  CLOUD_CODE_MONSTER_PET_PRESET_BASES.map((preset) => ({
    ...preset,
    ...LICENSED_IP_PRESET_OVERRIDE_BY_ID.get(preset.id),
  }));

export function getCloudCodeMonsterPreset(presetId?: string | null) {
  return (
    CLOUD_CODE_MONSTER_PET_PRESETS.find((preset) => preset.id === presetId) ??
    CLOUD_CODE_MONSTER_PET_PRESETS[0]!
  );
}

export function readCloudCodeMonsterPetPresetId() {
  if (typeof localStorage === "undefined") {
    return CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id;
  }

  try {
    return getCloudCodeMonsterPreset(
      localStorage.getItem(CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY)
    ).id;
  } catch {
    return CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id;
  }
}

export function writeCloudCodeMonsterPetPresetId(presetId: string) {
  const nextPreset = getCloudCodeMonsterPreset(presetId);

  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY, nextPreset.id);
    } catch {}
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT, {
        detail: { presetId: nextPreset.id },
      })
    );
  }

  return nextPreset.id;
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
  now = Date.now(),
  randomValue = Math.random()
): StoredCloudCodeMonsterActivity {
  if (
    stored &&
    stored.activityId &&
    isCloudCodeMonsterActivityId(stored.activityId) &&
    !shouldRefreshCloudCodeMonsterActivity(stored.updatedAt, now)
  ) {
    return stored;
  }

  return {
    activityId: pickCloudCodeMonsterActivity(randomValue).id,
    updatedAt: now,
    hiddenAt: null,
  };
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

export function simulateCloudCodeMonsterPreviewAway(now = Date.now()) {
  writeStoredActivity(createCloudCodeMonsterPreviewAwayState(now));
}

export function resolveCloudCodeMonsterPreviewComebackState(
  now = Date.now(),
  randomValue = Math.random()
) {
  return resolveCloudCodeMonsterVisibleState(
    createCloudCodeMonsterPreviewAwayState(now),
    now,
    randomValue
  );
}

export function resolveCloudCodeMonsterVisibleState(
  stored: StoredCloudCodeMonsterActivity | null,
  now = Date.now(),
  randomValue = Math.random()
): StoredCloudCodeMonsterActivity {
  if (stored?.hiddenAt) {
    if (shouldRefreshCloudCodeMonsterActivity(stored.hiddenAt, now)) {
      return {
        activityId: pickCloudCodeMonsterActivity(randomValue).id,
        updatedAt: now,
        hiddenAt: null,
      };
    }

    return {
      activityId: stored.activityId,
      updatedAt: stored.updatedAt,
      hiddenAt: null,
    };
  }

  if (!stored) {
    return resolveCloudCodeMonsterActivityState(stored, now, randomValue);
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

  if (activityId === "sleeping") {
    return "sleeping";
  }

  return "idle";
}

function readStoredActivity(): StoredCloudCodeMonsterActivity | null {
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

function writeStoredActivity(activityState: StoredCloudCodeMonsterActivity) {
  try {
    localStorage.setItem(
      CLOUD_CODE_MONSTER_STORAGE_KEY,
      JSON.stringify(activityState)
    );
  } catch {}
}

function getBounds(boundary: HTMLElement | null): PetBounds {
  return {
    width: boundary?.clientWidth ?? window.innerWidth,
    height: boundary?.clientHeight ?? window.innerHeight,
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
    const boundaryRect = boundary?.getBoundingClientRect();
    const agentRect = agentNode?.getBoundingClientRect();

    if (agentRect && boundaryRect) {
      return clampPetPosition(
        {
          x:
            agentRect.left -
            boundaryRect.left +
            agentRect.width / 2 -
            CLOUD_CODE_MONSTER_SIZE.width / 2,
          y:
            agentRect.top -
            boundaryRect.top -
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

function MonsterEyes({
  activityId,
  preset,
  reacting,
  shaken,
  fainted = false,
}: {
  activityId: CloudCodeMonsterActivityId | null;
  preset: CloudCodeMonsterPetPreset;
  reacting: boolean;
  shaken: boolean;
  fainted?: boolean;
}) {
  const expression = getCloudCodeMonsterExpression(
    activityId,
    reacting,
    shaken,
    fainted
  );

  if (expression === "fainted") {
    return (
      <>
        <rect x="43" y="39" width="5" height="5" fill={preset.eye} />
        <rect x="49" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="43" y="51" width="5" height="5" fill={preset.eye} />
        <rect x="49" y="39" width="5" height="5" fill={preset.eye} />
        <rect x="43" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="76" y="39" width="5" height="5" fill={preset.eye} />
        <rect x="82" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="76" y="51" width="5" height="5" fill={preset.eye} />
        <rect x="82" y="39" width="5" height="5" fill={preset.eye} />
        <rect x="76" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="58" y="64" width="14" height="4" fill={preset.eye} />
      </>
    );
  }

  if (expression === "shaken") {
    return (
      <>
        <rect x="45" y="40" width="5" height="5" fill={preset.eye} />
        <rect x="50" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="45" y="50" width="5" height="5" fill={preset.eye} />
        <rect x="82" y="40" width="5" height="5" fill={preset.eye} />
        <rect x="77" y="45" width="5" height="5" fill={preset.eye} />
        <rect x="82" y="50" width="5" height="5" fill={preset.eye} />
        <rect x="62" y="61" width="6" height="4" fill={preset.eye} />
      </>
    );
  }

  if (expression === "shocked") {
    return (
      <>
        <rect x="44" y="39" width="12" height="13" fill={preset.eye} />
        <rect x="76" y="39" width="12" height="13" fill={preset.eye} />
        <rect x="47" y="42" width="4" height="4" fill={preset.highlight} />
        <rect x="79" y="42" width="4" height="4" fill={preset.highlight} />
        <rect x="60" y="60" width="10" height="12" fill={preset.eye} />
        <rect x="62" y="62" width="6" height="3" fill="#332520" />
      </>
    );
  }

  if (expression === "sleeping") {
    return (
      <>
        <rect x="45" y="46" width="11" height="4" fill={preset.eye} />
        <rect x="76" y="46" width="11" height="4" fill={preset.eye} />
      </>
    );
  }

  return (
    <>
      <rect x="47" y="43" width="8" height="9" fill={preset.eye} />
      <rect x="78" y="43" width="8" height="9" fill={preset.eye} />
      <rect x="48" y="44" width="3" height="3" fill="#2c2521" />
      <rect x="79" y="44" width="3" height="3" fill="#2c2521" />
    </>
  );
}

function MonsterActivityAccessory({
  activityId,
  preset,
}: {
  activityId: CloudCodeMonsterActivityId | null;
  preset: CloudCodeMonsterPetPreset;
}) {
  if (!activityId) {
    return null;
  }

  if (activityId === "sleeping") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-sleep">
        <g className="cloud-code-monster-pet-sleep-z">
          <rect x="88" y="20" width="11" height="3" fill={preset.accent} />
          <rect x="94" y="23" width="4" height="3" fill={preset.accent} />
          <rect x="91" y="26" width="4" height="3" fill={preset.accent} />
          <rect x="88" y="29" width="11" height="3" fill={preset.accent} />
        </g>
        <g className="cloud-code-monster-pet-sleep-z">
          <rect x="99" y="12" width="14" height="3" fill={preset.accent} />
          <rect x="108" y="15" width="4" height="3" fill={preset.accent} />
          <rect x="104" y="18" width="4" height="3" fill={preset.accent} />
          <rect x="100" y="21" width="4" height="3" fill={preset.accent} />
          <rect x="99" y="24" width="14" height="3" fill={preset.accent} />
        </g>
        <g className="cloud-code-monster-pet-sleep-z">
          <rect x="114" y="2" width="17" height="4" fill={preset.accent} />
          <rect x="126" y="6" width="4" height="4" fill={preset.accent} />
          <rect x="122" y="10" width="4" height="4" fill={preset.accent} />
          <rect x="118" y="14" width="4" height="4" fill={preset.accent} />
          <rect x="114" y="18" width="17" height="4" fill={preset.accent} />
        </g>
      </g>
    );
  }

  if (activityId === "reading") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-book">
        <rect x="39" y="70" width="24" height="24" fill="#f5e6b8" />
        <rect x="65" y="70" width="24" height="24" fill="#ead394" />
        <rect x="63" y="70" width="4" height="26" fill="#6e4e2a" />
        <rect x="45" y="77" width="12" height="3" fill="#9a733d" />
        <rect x="71" y="77" width="12" height="3" fill="#9a733d" />
        <rect x="45" y="84" width="9" height="3" fill="#9a733d" />
      </g>
    );
  }

  if (activityId === "phone") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-phone">
        <rect x="76" y="62" width="18" height="29" fill="#2b2724" />
        <rect x="80" y="66" width="10" height="17" fill="#9ed7d4" />
        <rect x="83" y="86" width="4" height="3" fill="#f4e7d2" />
        <rect className="cloud-code-monster-pet-phone-glow" x="80" y="66" width="10" height="17" fill="#d5fff6" />
      </g>
    );
  }

  if (activityId === "coding") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-laptop">
        <rect x="35" y="68" width="58" height="25" fill="#2b2724" />
        <rect x="39" y="72" width="50" height="16" fill="#37322d" />
        <rect x="31" y="93" width="66" height="8" fill="#d8d0c6" />
        <rect x="47" y="77" width="10" height="3" fill={preset.accessory} />
        <rect x="58" y="80" width="4" height="3" fill={preset.accessory} />
        <rect x="66" y="83" width="13" height="3" fill={preset.accessory} />
      </g>
    );
  }

  if (activityId === "snacking") {
    return (
      <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-snack">
        <rect x="77" y="65" width="17" height="21" fill="#efc06d" />
        <rect x="81" y="71" width="9" height="3" fill="#7d5723" />
        <rect x="81" y="78" width="7" height="3" fill="#7d5723" />
        <rect x="67" y="59" width="8" height="8" fill={preset.accent} />
      </g>
    );
  }

  return (
    <g className="cloud-code-monster-pet-accessory cloud-code-monster-pet-thought">
      <rect x="92" y="25" width="8" height="8" fill={preset.accent} />
      <rect x="104" y="17" width="6" height="6" fill={preset.bodyLight} />
      <rect x="113" y="9" width="5" height="5" fill={preset.highlight} />
    </g>
  );
}

function MonsterPresetFeature({
  preset,
}: {
  preset: CloudCodeMonsterPetPreset;
}) {
  const { feature } = preset;

  if (feature === "horns") {
    return (
      <>
        <rect x="29" y="20" width="10" height="8" fill={preset.accent} />
        <rect x="91" y="20" width="10" height="8" fill={preset.accent} />
        <rect x="34" y="16" width="7" height="7" fill={preset.accessory} />
        <rect x="88" y="16" width="7" height="7" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "ears") {
    return (
      <>
        <rect x="18" y="38" width="10" height="18" fill={preset.bodyDark} />
        <rect x="100" y="38" width="10" height="18" fill={preset.bodyDark} />
        <rect x="21" y="42" width="5" height="8" fill={preset.bodyLight} />
        <rect x="102" y="42" width="5" height="8" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "visor") {
    return (
      <>
        <rect x="41" y="36" width="47" height="5" fill={preset.accent} />
        <rect x="45" y="38" width="39" height="3" fill={preset.highlight} />
      </>
    );
  }

  if (feature === "antenna") {
    return (
      <>
        <rect x="62" y="15" width="5" height="13" fill={preset.accent} />
        <rect x="58" y="10" width="13" height="6" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "crown") {
    return (
      <>
        <rect x="43" y="18" width="8" height="10" fill={preset.accessory} />
        <rect x="60" y="14" width="8" height="14" fill={preset.accessory} />
        <rect x="77" y="18" width="8" height="10" fill={preset.accessory} />
        <rect x="42" y="26" width="44" height="5" fill={preset.accent} />
      </>
    );
  }

  if (feature === "bell") {
    return (
      <>
        <rect x="22" y="42" width="8" height="14" fill={preset.bodyDark} />
        <rect x="98" y="42" width="8" height="14" fill={preset.bodyDark} />
        <rect x="59" y="21" width="11" height="7" fill={preset.accent} />
      </>
    );
  }

  if (feature === "bolt") {
    return (
      <>
        <rect x="29" y="20" width="8" height="17" fill={preset.accent} />
        <rect x="91" y="20" width="8" height="17" fill={preset.accent} />
        <rect x="33" y="32" width="8" height="9" fill={preset.bodyTop} />
        <rect x="87" y="32" width="8" height="9" fill={preset.bodyTop} />
      </>
    );
  }

  if (feature === "star") {
    return (
      <>
        <rect x="60" y="13" width="8" height="24" fill={preset.accessory} />
        <rect x="52" y="21" width="24" height="8" fill={preset.accessory} />
        <rect x="56" y="17" width="16" height="16" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "leaf" || feature === "sprout") {
    return (
      <>
        <rect x="61" y="15" width="6" height="18" fill={preset.accent} />
        <rect x="49" y="18" width="16" height="10" fill={preset.accent} />
        <rect x="66" y="18" width="16" height="10" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "flame") {
    return (
      <>
        <rect x="58" y="9" width="12" height="20" fill={preset.accessory} />
        <rect x="52" y="18" width="9" height="14" fill={preset.accent} />
        <rect x="69" y="17" width="8" height="15" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "fins") {
    return (
      <>
        <rect x="18" y="45" width="10" height="18" fill={preset.accent} />
        <rect x="100" y="45" width="10" height="18" fill={preset.accent} />
        <rect x="55" y="18" width="18" height="10" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "moon") {
    return (
      <>
        <rect x="57" y="14" width="18" height="18" fill={preset.accessory} />
        <rect x="64" y="12" width="15" height="19" fill={preset.bodyTop} />
        <rect x="24" y="37" width="7" height="18" fill={preset.bodyDark} />
        <rect x="97" y="37" width="7" height="18" fill={preset.bodyDark} />
      </>
    );
  }

  if (feature === "mushroom") {
    return (
      <>
        <rect x="31" y="18" width="66" height="22" fill={preset.bodyTop} />
        <rect x="42" y="13" width="44" height="11" fill={preset.bodyTop} />
        <rect x="45" y="22" width="9" height="8" fill={preset.accessory} />
        <rect x="73" y="20" width="10" height="8" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "spin") {
    return (
      <>
        <rect x="47" y="17" width="34" height="9" fill={preset.bodyLight} />
        <rect x="37" y="24" width="14" height="8" fill={preset.bodyLight} />
        <rect x="78" y="24" width="13" height="8" fill={preset.bodyLight} />
        <rect x="29" y="31" width="11" height="7" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "chomp") {
    return (
      <>
        <rect x="88" y="48" width="14" height="8" fill={preset.highlight} />
        <rect x="88" y="60" width="14" height="8" fill={preset.highlight} />
      </>
    );
  }

  if (feature === "ghost" || feature === "slime") {
    return (
      <>
        <rect x="44" y="19" width="40" height="12" fill={preset.bodyLight} />
        <rect x="36" y="27" width="56" height="10" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "cap" || feature === "straw") {
    return (
      <>
        <rect x="34" y="18" width="58" height="12" fill={feature === "straw" ? preset.accessory : preset.bodyTop} />
        <rect x="45" y="12" width="36" height="10" fill={feature === "straw" ? preset.accessory : preset.bodyTop} />
        <rect x="58" y="22" width="14" height="5" fill={feature === "straw" ? preset.accent : preset.accessory} />
      </>
    );
  }

  if (feature === "bow" || feature === "hood") {
    return (
      <>
        <rect x="76" y="17" width="13" height="13" fill={preset.accent} />
        <rect x="91" y="17" width="13" height="13" fill={preset.accent} />
        <rect x="88" y="21" width="7" height="7" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "mask" || feature === "ninja") {
    return (
      <>
        <rect x="35" y="25" width="58" height="8" fill={preset.accent} />
        <rect x="48" y="18" width="12" height="10" fill={preset.accent} />
        <rect x="69" y="18" width="12" height="10" fill={preset.accent} />
      </>
    );
  }

  if (feature === "soot") {
    return (
      <>
        <rect x="27" y="25" width="8" height="8" fill={preset.bodyLight} />
        <rect x="92" y="23" width="9" height="9" fill={preset.bodyLight} />
        <rect x="61" y="12" width="7" height="7" fill={preset.bodyLight} />
      </>
    );
  }

  if (feature === "pearl" || feature === "wand") {
    return (
      <>
        <rect x="58" y="12" width="13" height="13" fill={preset.accessory} />
        <rect x="61" y="7" width="7" height="7" fill={preset.accent} />
        <rect x="73" y="17" width="9" height="9" fill={preset.accent} />
      </>
    );
  }

  if (feature === "mecha") {
    return (
      <>
        <rect x="29" y="24" width="12" height="13" fill={preset.accent} />
        <rect x="87" y="24" width="12" height="13" fill={preset.accent} />
        <rect x="51" y="18" width="27" height="9" fill={preset.accessory} />
      </>
    );
  }

  if (feature === "ink") {
    return (
      <>
        <rect x="35" y="19" width="12" height="16" fill={preset.accent} />
        <rect x="56" y="14" width="14" height="20" fill={preset.accent} />
        <rect x="80" y="19" width="12" height="16" fill={preset.accent} />
      </>
    );
  }

  if (feature === "drum") {
    return (
      <>
        <rect x="31" y="27" width="66" height="7" fill={preset.accent} />
        <rect x="41" y="18" width="46" height="10" fill={preset.accessory} />
      </>
    );
  }

  return (
    <>
      <rect x="38" y="30" width="10" height="4" fill={preset.bodyLight} />
      <rect x="80" y="30" width="10" height="4" fill={preset.bodyDark} />
    </>
  );
}

function MonsterPresetBodyMarks({
  preset,
}: {
  preset: CloudCodeMonsterPetPreset;
}) {
  const feature = preset.feature as string;

  return (
    <>
      {preset.facePatch ? (
        <>
          <rect x="40" y="39" width="48" height="34" fill={preset.facePatch} />
          <rect x="46" y="73" width="36" height="10" fill={preset.facePatch} />
        </>
      ) : null}
      {feature === "bell" ? (
        <>
          <rect x="50" y="74" width="28" height="6" fill={preset.accent} />
          <rect x="58" y="80" width="13" height="11" fill={preset.accessory} />
          <rect x="61" y="84" width="7" height="3" fill={preset.eye} />
        </>
      ) : null}
      {feature === "bolt" ? (
        <rect x="89" y="76" width="13" height="8" fill={preset.accent} />
      ) : null}
      {feature === "chomp" ? (
        <rect x="72" y="56" width="22" height="16" fill={preset.highlight} />
      ) : null}
      {feature === "ghost" ? (
        <>
          <rect x="28" y="91" width="12" height="8" fill={preset.bodyLight} />
          <rect x="52" y="91" width="12" height="8" fill={preset.bodyLight} />
          <rect x="76" y="91" width="12" height="8" fill={preset.bodyLight} />
        </>
      ) : null}
      {feature === "drum" ? (
        <rect x="31" y="55" width="66" height="8" fill={preset.accessory} />
      ) : null}
      {feature === "mecha" ? (
        <>
          <rect x="41" y="35" width="45" height="6" fill={preset.accent} />
          <rect x="57" y="58" width="14" height="9" fill={preset.accessory} />
        </>
      ) : null}
      {preset.cheek ? (
        <>
          <rect x="36" y="58" width="8" height="7" fill={preset.cheek} />
          <rect x="86" y="58" width="8" height="7" fill={preset.cheek} />
        </>
      ) : null}
    </>
  );
}

function DirectPixelEyes({
  activityId,
  preset,
  reacting,
  shaken,
  fainted = false,
  leftX = 47,
  rightX = 78,
  y = 43,
  color,
  highlightColor,
  singleEye = false,
  mouthX = 61,
  mouthY,
  mouthWidth = 10,
  mouthHeight = 4,
  mouthColor,
  mouthStyle = "flat",
}: {
  activityId: CloudCodeMonsterActivityId | null;
  preset: CloudCodeMonsterPetPreset;
  reacting: boolean;
  shaken: boolean;
  fainted?: boolean;
  leftX?: number;
  rightX?: number;
  y?: number;
  color?: string;
  highlightColor?: string;
  singleEye?: boolean;
  mouthX?: number;
  mouthY?: number;
  mouthWidth?: number;
  mouthHeight?: number;
  mouthColor?: string;
  mouthStyle?: "flat" | "open" | "smile" | "none";
}) {
  const expression = getCloudCodeMonsterExpression(
    activityId,
    reacting,
    shaken,
    fainted
  );
  const eye = color ?? preset.eye;
  const highlight = highlightColor ?? preset.highlight;
  const faceMouthY = mouthY ?? y + 21;
  const faceMouthColor = mouthColor ?? eye;
  const secondEyeX = singleEye ? null : rightX;
  const renderEyeBlock = (
    eyeX: number,
    eyeY: number,
    width = 8,
    height = 9,
    includeHighlight = true
  ) => (
    <>
      <rect x={eyeX} y={eyeY} width={width} height={height} fill={eye} />
      {includeHighlight ? (
        <rect x={eyeX + 1} y={eyeY + 1} width="3" height="3" fill={highlight} />
      ) : null}
    </>
  );
  const renderMouth = (
    style = mouthStyle,
    x = mouthX,
    mouthTop = faceMouthY,
    width = mouthWidth,
    height = mouthHeight
  ) => {
    if (style === "none") {
      return null;
    }

    if (style === "open") {
      return (
        <>
          <rect x={x} y={mouthTop} width={width} height={height + 7} fill={faceMouthColor} />
          <rect x={x + 2} y={mouthTop + 2} width={Math.max(3, width - 4)} height="3" fill="#332520" />
        </>
      );
    }

    if (style === "smile") {
      return (
        <>
          <rect x={x} y={mouthTop} width={width} height={height} fill={faceMouthColor} />
          <rect x={x - 3} y={mouthTop - 3} width="4" height={height} fill={faceMouthColor} />
          <rect x={x + width - 1} y={mouthTop - 3} width="4" height={height} fill={faceMouthColor} />
        </>
      );
    }

    return <rect x={x} y={mouthTop} width={width} height={height} fill={faceMouthColor} />;
  };

  if (expression === "fainted") {
    return (
      <>
        <rect x={leftX - 3} y={y - 3} width="5" height="5" fill={eye} />
        <rect x={leftX + 3} y={y + 3} width="5" height="5" fill={eye} />
        <rect x={leftX + 3} y={y - 3} width="5" height="5" fill={eye} />
        <rect x={leftX - 3} y={y + 3} width="5" height="5" fill={eye} />
        {secondEyeX === null ? null : (
          <>
            <rect x={secondEyeX - 3} y={y - 3} width="5" height="5" fill={eye} />
            <rect x={secondEyeX + 3} y={y + 3} width="5" height="5" fill={eye} />
            <rect x={secondEyeX + 3} y={y - 3} width="5" height="5" fill={eye} />
            <rect x={secondEyeX - 3} y={y + 3} width="5" height="5" fill={eye} />
          </>
        )}
        {renderMouth("flat", mouthX - 2, faceMouthY + 1, mouthWidth + 5, mouthHeight)}
      </>
    );
  }

  if (expression === "shaken") {
    return (
      <>
        <rect x={leftX - 2} y={y - 2} width="5" height="5" fill={eye} />
        <rect x={leftX + 3} y={y + 3} width="5" height="5" fill={eye} />
        <rect x={leftX - 2} y={y + 8} width="5" height="5" fill={eye} />
        {secondEyeX === null ? null : (
          <>
            <rect x={secondEyeX + 3} y={y - 2} width="5" height="5" fill={eye} />
            <rect x={secondEyeX - 2} y={y + 3} width="5" height="5" fill={eye} />
            <rect x={secondEyeX + 3} y={y + 8} width="5" height="5" fill={eye} />
          </>
        )}
        {renderMouth("open", mouthX, faceMouthY, Math.max(6, mouthWidth - 1), mouthHeight)}
      </>
    );
  }

  if (expression === "shocked") {
    return (
      <>
        <rect x={leftX - 3} y={y - 3} width="12" height="13" fill={eye} />
        {secondEyeX === null ? null : (
          <rect x={secondEyeX - 3} y={y - 3} width="12" height="13" fill={eye} />
        )}
        <rect x={leftX} y={y} width="4" height="4" fill={highlight} />
        {secondEyeX === null ? null : (
          <rect x={secondEyeX} y={y} width="4" height="4" fill={highlight} />
        )}
        {renderMouth("open", mouthX, faceMouthY - 3, mouthWidth, mouthHeight + 1)}
      </>
    );
  }

  if (expression === "sleeping") {
    return (
      <>
        <rect x={leftX - 2} y={y + 3} width="12" height="4" fill={eye} />
        {secondEyeX === null ? null : (
          <rect x={secondEyeX - 2} y={y + 3} width="12" height="4" fill={eye} />
        )}
        {renderMouth("flat", mouthX, faceMouthY, mouthWidth, mouthHeight)}
      </>
    );
  }

  return (
    <>
      {renderEyeBlock(leftX, y)}
      {secondEyeX === null ? null : renderEyeBlock(secondEyeX, y)}
      {renderMouth()}
    </>
  );
}

function MonsterDirectPixelCharacter({
  preset,
  activityId,
  reacting,
  shaken,
  fainted,
}: {
  preset: CloudCodeMonsterPetPreset;
  activityId: CloudCodeMonsterActivityId | null;
  reacting: boolean;
  shaken: boolean;
  fainted: boolean;
}) {
  const shape = preset.shape;

  switch (shape) {
    case "doraemon":
      return (
        <>
          <rect x="36" y="23" width="56" height="13" fill="#2d9bd3" />
          <rect x="28" y="36" width="72" height="45" fill="#2d9bd3" />
          <rect x="37" y="43" width="54" height="36" fill="#f8fbff" />
          <rect x="44" y="80" width="40" height="22" fill="#2d9bd3" />
          <rect x="34" y="81" width="60" height="6" fill="#d9403f" />
          <rect x="58" y="87" width="13" height="12" fill="#f0bf36" />
          <rect className="cloud-code-monster-pet-left-foot" x="36" y="103" width="21" height="11" fill="#f8fbff" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="103" width="21" height="11" fill="#f8fbff" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={45} rightX={76} y={44} mouthX={56} mouthY={71} mouthWidth={18} mouthHeight={3} mouthColor="#111318" mouthStyle="smile" />
          <rect x="62" y="55" width="6" height="6" fill="#d9403f" />
          <rect x="62" y="61" width="3" height="12" fill="#111318" />
          <rect x="54" y="73" width="20" height="3" fill="#111318" />
        </>
      );
    case "pikachu":
      return (
        <>
          <rect x="31" y="15" width="10" height="31" fill="#2b2319" />
          <rect x="87" y="15" width="10" height="31" fill="#2b2319" />
          <rect x="36" y="25" width="10" height="27" fill="#f1ce43" />
          <rect x="82" y="25" width="10" height="27" fill="#f1ce43" />
          <rect x="37" y="39" width="54" height="14" fill="#f4d64f" />
          <rect x="29" y="53" width="70" height="44" fill="#f1c93b" />
          <rect x="93" y="59" width="19" height="10" fill="#8d5d28" />
          <rect x="105" y="49" width="10" height="20" fill="#f1c93b" />
          <rect className="cloud-code-monster-pet-left-foot" x="37" y="96" width="18" height="15" fill="#d7a72e" />
          <rect className="cloud-code-monster-pet-right-foot" x="74" y="96" width="18" height="15" fill="#d7a72e" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={45} rightX={77} y={54} />
          <rect x="34" y="68" width="11" height="10" fill="#e84b43" />
          <rect x="84" y="68" width="11" height="10" fill="#e84b43" />
        </>
      );
    case "kirby":
      return (
        <>
          <rect x="42" y="29" width="44" height="9" fill="#f2a8bd" />
          <rect x="29" y="38" width="70" height="52" fill="#ee86a7" />
          <rect x="40" y="90" width="48" height="13" fill="#d96c91" />
          <rect x="18" y="57" width="17" height="18" fill="#ee86a7" />
          <rect x="93" y="57" width="17" height="18" fill="#ee86a7" />
          <rect className="cloud-code-monster-pet-left-foot" x="35" y="100" width="22" height="12" fill="#c94d62" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="100" width="22" height="12" fill="#c94d62" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={48} rightX={75} y={51} color="#24335b" mouthX={61} mouthY={66} mouthWidth={10} mouthHeight={5} mouthColor="#7c2448" mouthStyle="smile" />
          <rect x="43" y="69" width="9" height="8" fill="#e95d77" />
          <rect x="83" y="69" width="9" height="8" fill="#e95d77" />
        </>
      );
    case "bulbasaur":
      return (
        <>
          <rect x="45" y="20" width="38" height="18" fill="#5e9f5b" />
          <rect x="38" y="31" width="52" height="22" fill="#74b86b" />
          <rect x="30" y="50" width="68" height="38" fill="#69b8a6" />
          <rect x="20" y="64" width="22" height="23" fill="#69b8a6" />
          <rect x="86" y="64" width="22" height="23" fill="#4c9f92" />
          <rect className="cloud-code-monster-pet-left-foot" x="29" y="88" width="16" height="16" fill="#4c9f92" />
          <rect className="cloud-code-monster-pet-right-foot" x="82" y="88" width="16" height="16" fill="#408b80" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={44} rightX={74} y={56} color="#b33b42" />
          <rect x="53" y="75" width="7" height="4" fill="#2d5d56" />
          <rect x="67" y="75" width="7" height="4" fill="#2d5d56" />
        </>
      );
    case "charmander":
      return (
        <>
          <rect x="38" y="29" width="50" height="13" fill="#e88743" />
          <rect x="30" y="42" width="66" height="45" fill="#d76d35" />
          <rect x="41" y="70" width="39" height="28" fill="#f2c878" />
          <rect x="88" y="70" width="17" height="10" fill="#d76d35" />
          <rect x="101" y="58" width="9" height="15" fill="#f0b540" />
          <rect x="103" y="51" width="7" height="9" fill="#e24c38" />
          <rect className="cloud-code-monster-pet-left-foot" x="36" y="98" width="17" height="14" fill="#b9542c" />
          <rect className="cloud-code-monster-pet-right-foot" x="75" y="98" width="17" height="14" fill="#b9542c" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={48} rightX={77} y={50} />
        </>
      );
    case "squirtle":
      return (
        <>
          <rect x="39" y="27" width="50" height="13" fill="#83b7d8" />
          <rect x="31" y="40" width="66" height="39" fill="#6aa4cf" />
          <rect x="37" y="76" width="55" height="25" fill="#b9854a" />
          <rect x="45" y="80" width="39" height="17" fill="#ecd59a" />
          <rect x="16" y="62" width="20" height="16" fill="#6aa4cf" />
          <rect x="92" y="62" width="20" height="16" fill="#6aa4cf" />
          <rect className="cloud-code-monster-pet-left-foot" x="35" y="101" width="18" height="12" fill="#5c92bd" />
          <rect className="cloud-code-monster-pet-right-foot" x="76" y="101" width="18" height="12" fill="#5c92bd" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={46} rightX={76} y={48} />
        </>
      );
    case "minecraft-steve":
      return (
        <>
          <rect x="42" y="18" width="44" height="14" fill="#5b3625" />
          <rect x="36" y="32" width="56" height="42" fill="#b98363" />
          <rect x="36" y="74" width="56" height="28" fill="#2b9aa0" />
          <rect x="28" y="78" width="11" height="28" fill="#b98363" />
          <rect x="89" y="78" width="11" height="28" fill="#b98363" />
          <rect className="cloud-code-monster-pet-left-foot" x="42" y="102" width="18" height="16" fill="#31549a" />
          <rect className="cloud-code-monster-pet-right-foot" x="68" y="102" width="18" height="16" fill="#31549a" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={48} rightX={73} y={46} color="#2b2018" mouthX={57} mouthY={59} mouthWidth={14} mouthHeight={4} mouthColor="#6c3f2b" />
          <rect x="57" y="59" width="14" height="4" fill="#6c3f2b" />
        </>
      );
    case "minecraft-creeper":
      return (
        <>
          <rect x="37" y="20" width="54" height="54" fill="#5aaa4c" />
          <rect x="44" y="27" width="10" height="10" fill="#78c763" />
          <rect x="72" y="34" width="11" height="11" fill="#458d3d" />
          <rect x="42" y="74" width="44" height="32" fill="#4b963f" />
          <rect className="cloud-code-monster-pet-left-foot" x="34" y="101" width="18" height="15" fill="#397b35" />
          <rect className="cloud-code-monster-pet-left-foot" x="54" y="101" width="18" height="15" fill="#397b35" />
          <rect className="cloud-code-monster-pet-right-foot" x="76" y="101" width="18" height="15" fill="#397b35" />
          <rect x="47" y="40" width="11" height="13" fill="#151711" />
          <rect x="70" y="40" width="11" height="13" fill="#151711" />
          <rect x="59" y="54" width="10" height="18" fill="#151711" />
          <rect x="51" y="64" width="10" height="8" fill="#151711" />
          <rect x="67" y="64" width="10" height="8" fill="#151711" />
        </>
      );
    case "minecraft-zombie":
      return (
        <>
          <rect x="38" y="22" width="52" height="49" fill="#77a86c" />
          <rect x="37" y="71" width="54" height="31" fill="#248f9e" />
          <rect x="25" y="74" width="14" height="30" fill="#77a86c" />
          <rect x="89" y="74" width="14" height="30" fill="#77a86c" />
          <rect className="cloud-code-monster-pet-left-foot" x="41" y="102" width="18" height="16" fill="#5d4aa1" />
          <rect className="cloud-code-monster-pet-right-foot" x="69" y="102" width="18" height="16" fill="#5d4aa1" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={49} rightX={73} y={43} color="#2b221d" mouthX={57} mouthY={58} mouthWidth={14} mouthHeight={4} mouthColor="#2b221d" />
          <rect x="57" y="58" width="14" height="4" fill="#2b221d" />
        </>
      );
    case "toad":
      return (
        <>
          <rect x="29" y="19" width="70" height="22" fill="#fff3e4" />
          <rect x="38" y="8" width="52" height="18" fill="#fff3e4" />
          <rect x="42" y="20" width="16" height="13" fill="#d84741" />
          <rect x="70" y="16" width="15" height="13" fill="#d84741" />
          <rect x="39" y="43" width="50" height="40" fill="#f0c89c" />
          <rect x="36" y="78" width="56" height="24" fill="#f7f1dc" />
          <rect x="31" y="80" width="11" height="20" fill="#2d5ca8" />
          <rect x="86" y="80" width="11" height="20" fill="#2d5ca8" />
          <rect className="cloud-code-monster-pet-left-foot" x="38" y="102" width="17" height="12" fill="#7a5735" />
          <rect className="cloud-code-monster-pet-right-foot" x="73" y="102" width="17" height="12" fill="#7a5735" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={48} rightX={74} y={54} />
        </>
      );
    case "sonic":
      return (
        <>
          <rect x="33" y="22" width="17" height="13" fill="#2d62b3" />
          <rect x="43" y="13" width="22" height="14" fill="#2d62b3" />
          <rect x="61" y="17" width="23" height="12" fill="#2d62b3" />
          <rect x="36" y="31" width="55" height="42" fill="#356fc1" />
          <rect x="42" y="48" width="40" height="25" fill="#e4c19b" />
          <rect x="44" y="74" width="39" height="26" fill="#356fc1" />
          <rect className="cloud-code-monster-pet-left-foot" x="31" y="99" width="26" height="12" fill="#d9463f" />
          <rect className="cloud-code-monster-pet-right-foot" x="71" y="99" width="26" height="12" fill="#d9463f" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={49} rightX={74} y={42} />
        </>
      );
    case "pacman":
      return (
        <>
          <rect x="43" y="28" width="45" height="11" fill="#f1d34a" />
          <rect x="31" y="39" width="56" height="49" fill="#edc738" />
          <rect x="42" y="88" width="44" height="11" fill="#cfa62a" />
          <rect x="82" y="52" width="20" height="11" fill="#fff8de" />
          <rect x="82" y="65" width="15" height="11" fill="#fff8de" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={58} rightX={58} y={43} singleEye mouthX={84} mouthY={62} mouthWidth={15} mouthHeight={7} mouthColor="#15110d" mouthStyle="open" />
        </>
      );
    case "boo":
      return (
        <>
          <rect x="39" y="26" width="50" height="12" fill="#f0f2fb" />
          <rect x="29" y="38" width="70" height="48" fill="#e0e5f3" />
          <rect x="23" y="55" width="13" height="18" fill="#e0e5f3" />
          <rect x="92" y="55" width="13" height="18" fill="#d0d8ea" />
          <rect x="31" y="86" width="13" height="12" fill="#e0e5f3" />
          <rect x="56" y="86" width="13" height="12" fill="#e0e5f3" />
          <rect x="81" y="86" width="13" height="12" fill="#e0e5f3" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={45} rightX={77} y={47} mouthX={56} mouthY={63} mouthWidth={19} mouthHeight={10} mouthColor="#df7198" mouthStyle="open" />
          <rect x="57" y="63" width="18" height="13" fill="#df7198" />
        </>
      );
    case "mario":
      return (
        <>
          <rect x="35" y="18" width="58" height="12" fill="#d34437" />
          <rect x="46" y="9" width="35" height="12" fill="#d34437" />
          <rect x="39" y="31" width="50" height="38" fill="#c8916b" />
          <rect x="52" y="55" width="28" height="8" fill="#4c2d20" />
          <rect x="36" y="69" width="56" height="32" fill="#2f5aa8" />
          <rect x="30" y="71" width="14" height="28" fill="#d34437" />
          <rect x="84" y="71" width="14" height="28" fill="#d34437" />
          <rect className="cloud-code-monster-pet-left-foot" x="35" y="101" width="21" height="13" fill="#6c3e27" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="101" width="21" height="13" fill="#6c3e27" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={49} rightX={74} y={41} />
        </>
      );
    case "pooh":
      return (
        <>
          <rect x="31" y="30" width="13" height="14" fill="#d99b39" />
          <rect x="84" y="30" width="13" height="14" fill="#c88730" />
          <rect x="38" y="26" width="52" height="46" fill="#e0a33f" />
          <rect x="32" y="72" width="64" height="29" fill="#c9473c" />
          <rect className="cloud-code-monster-pet-left-foot" x="37" y="101" width="18" height="14" fill="#b87a2e" />
          <rect className="cloud-code-monster-pet-right-foot" x="74" y="101" width="18" height="14" fill="#b87a2e" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={48} rightX={75} y={47} />
          <rect x="61" y="59" width="7" height="5" fill="#4a2c1e" />
        </>
      );
    case "hello-kitty":
      return (
        <>
          <rect x="28" y="25" width="16" height="18" fill="#f6f3ea" />
          <rect x="84" y="25" width="16" height="18" fill="#f6f3ea" />
          <rect x="33" y="31" width="62" height="45" fill="#f6f3ea" />
          <rect x="76" y="24" width="13" height="13" fill="#d94c5e" />
          <rect x="91" y="24" width="13" height="13" fill="#d94c5e" />
          <rect x="87" y="28" width="8" height="8" fill="#e8c94a" />
          <rect x="39" y="76" width="50" height="26" fill="#d94c5e" />
          <rect className="cloud-code-monster-pet-left-foot" x="38" y="102" width="18" height="11" fill="#f6f3ea" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="102" width="18" height="11" fill="#f6f3ea" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={46} rightX={78} y={49} color="#25201f" highlightColor="#fffdfa" mouthX={61} mouthY={64} mouthWidth={7} mouthHeight={2} mouthColor="#7b4542" mouthStyle="smile" />
          <rect x="61" y="58" width="8" height="6" fill="#e0ad31" />
          <rect x="63" y="59" width="4" height="3" fill="#f6d75b" />
          <rect x="39" y="58" width="7" height="2" fill="#25201f" opacity="0.72" />
          <rect x="82" y="58" width="7" height="2" fill="#25201f" opacity="0.72" />
        </>
      );
    case "my-melody":
    case "kuromi": {
      const isKuromi = shape === "kuromi";
      const hood = isKuromi ? "#51425c" : "#e78eaa";
      const accent = isKuromi ? "#dd6d99" : "#d84c64";
      return (
        <>
          <rect x="27" y="12" width="13" height="42" fill={hood} />
          <rect x="88" y="12" width="13" height="42" fill={hood} />
          <rect x="35" y="25" width="58" height="54" fill={hood} />
          <rect x="42" y="39" width="44" height="34" fill="#fff5ee" />
          {isKuromi ? (
            <>
              <rect x="57" y="28" width="14" height="10" fill="#f2e9e1" />
              <rect x="60" y="31" width="3" height="3" fill="#51425c" />
              <rect x="66" y="31" width="3" height="3" fill="#51425c" />
              <rect x="63" y="35" width="3" height="2" fill="#51425c" />
            </>
          ) : null}
          <rect x="48" y="57" width="7" height="6" fill={isKuromi ? "#f2dfe8" : "#f3d6dc"} />
          <rect x="76" y="57" width="7" height="6" fill={isKuromi ? "#f2dfe8" : "#f3d6dc"} />
          <rect x="38" y="79" width="52" height="25" fill={accent} />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="104" width="17" height="10" fill={hood} />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="104" width="17" height="10" fill={hood} />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={50} rightX={75} y={49} color="#31232f" highlightColor="#fff5ee" mouthX={60} mouthY={64} mouthWidth={9} mouthHeight={3} mouthColor="#7a3c55" mouthStyle="smile" />
        </>
      );
    }
    case "totoro":
      return (
        <>
          <rect x="38" y="16" width="10" height="22" fill="#74766a" />
          <rect x="80" y="16" width="10" height="22" fill="#74766a" />
          <rect x="36" y="30" width="56" height="17" fill="#85877a" />
          <rect x="24" y="47" width="80" height="54" fill="#74766a" />
          <rect x="38" y="65" width="52" height="33" fill="#dad3b8" />
          <rect x="46" y="72" width="8" height="5" fill="#74766a" />
          <rect x="61" y="72" width="8" height="5" fill="#74766a" />
          <rect x="76" y="72" width="8" height="5" fill="#74766a" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={47} rightX={76} y={47} />
        </>
      );
    case "soot-sprite":
      return (
        <>
          <rect x="38" y="29" width="52" height="9" fill="#2b2c31" />
          <rect x="27" y="38" width="74" height="45" fill="#1f2026" />
          <rect x="36" y="83" width="56" height="12" fill="#17181e" />
          <rect x="22" y="45" width="9" height="9" fill="#1f2026" />
          <rect x="97" y="48" width="9" height="9" fill="#1f2026" />
          <rect x="48" y="52" width="14" height="14" fill="#f5f2dc" />
          <rect x="69" y="52" width="14" height="14" fill="#f5f2dc" />
          <rect x="53" y="56" width="5" height="6" fill="#17181e" />
          <rect x="74" y="56" width="5" height="6" fill="#17181e" />
        </>
      );
    case "luffy":
      return (
        <>
          <rect x="31" y="18" width="66" height="9" fill="#e7c65d" />
          <rect x="40" y="8" width="48" height="15" fill="#e7c65d" />
          <rect x="43" y="22" width="42" height="6" fill="#c84f3e" />
          <rect x="38" y="31" width="52" height="39" fill="#d89064" />
          <rect x="36" y="70" width="56" height="31" fill="#cf4d3f" />
          <rect x="45" y="82" width="38" height="20" fill="#2c5ca0" />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="102" width="18" height="13" fill="#d89064" />
          <rect className="cloud-code-monster-pet-right-foot" x="71" y="102" width="18" height="13" fill="#d89064" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={49} rightX={75} y={44} />
        </>
      );
    case "naruto":
      return (
        <>
          <rect x="34" y="18" width="11" height="16" fill="#e0a641" />
          <rect x="48" y="12" width="10" height="22" fill="#e0a641" />
          <rect x="61" y="14" width="10" height="20" fill="#e0a641" />
          <rect x="75" y="18" width="11" height="16" fill="#e0a641" />
          <rect x="36" y="32" width="56" height="9" fill="#2f4560" />
          <rect x="55" y="34" width="18" height="6" fill="#c9ccd2" />
          <rect x="38" y="41" width="52" height="34" fill="#dfa06c" />
          <rect x="34" y="75" width="60" height="31" fill="#e27a31" />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="106" width="18" height="10" fill="#2f4560" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="106" width="18" height="10" fill="#2f4560" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={49} rightX={75} y={50} />
        </>
      );
    case "goku":
      return (
        <>
          <rect x="35" y="14" width="13" height="23" fill="#191817" />
          <rect x="50" y="6" width="13" height="31" fill="#191817" />
          <rect x="66" y="9" width="13" height="28" fill="#191817" />
          <rect x="80" y="18" width="12" height="19" fill="#191817" />
          <rect x="38" y="35" width="52" height="38" fill="#dc9864" />
          <rect x="33" y="73" width="62" height="31" fill="#df7a30" />
          <rect x="52" y="77" width="24" height="29" fill="#244f91" />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="104" width="19" height="12" fill="#244f91" />
          <rect className="cloud-code-monster-pet-right-foot" x="71" y="104" width="19" height="12" fill="#244f91" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={49} rightX={75} y={47} />
        </>
      );
    case "sailor-moon":
      return (
        <>
          <rect x="29" y="24" width="14" height="14" fill="#e6c44e" />
          <rect x="85" y="24" width="14" height="14" fill="#e6c44e" />
          <rect x="40" y="12" width="48" height="31" fill="#e6c44e" />
          <rect x="38" y="38" width="52" height="35" fill="#e6a96b" />
          <rect x="34" y="73" width="60" height="31" fill="#f3eee9" />
          <rect x="42" y="72" width="44" height="8" fill="#2f5ca9" />
          <rect x="58" y="80" width="12" height="19" fill="#d9495d" />
          <rect className="cloud-code-monster-pet-left-foot" x="38" y="104" width="18" height="10" fill="#d9495d" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="104" width="18" height="10" fill="#d9495d" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={49} rightX={75} y={48} />
        </>
      );
    case "gundam":
      return (
        <>
          <rect x="38" y="25" width="52" height="39" fill="#d7dbe2" />
          <rect x="31" y="28" width="10" height="18" fill="#d94b43" />
          <rect x="87" y="28" width="10" height="18" fill="#d94b43" />
          <rect x="54" y="17" width="7" height="17" fill="#e8c64c" />
          <rect x="68" y="17" width="7" height="17" fill="#e8c64c" />
          <rect x="45" y="44" width="38" height="8" fill="#26344f" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={50} rightX={70} y={44} color="#edf6ff" highlightColor="#7fd7ff" mouthX={58} mouthY={57} mouthWidth={13} mouthHeight={3} mouthColor="#d94b43" />
          <rect x="34" y="64" width="60" height="39" fill="#eef1f5" />
          <rect x="48" y="68" width="32" height="19" fill="#315aa8" />
          <rect x="56" y="70" width="16" height="12" fill="#d94b43" />
          <rect className="cloud-code-monster-pet-left-foot" x="38" y="103" width="20" height="12" fill="#26344f" />
          <rect className="cloud-code-monster-pet-right-foot" x="70" y="103" width="20" height="12" fill="#26344f" />
        </>
      );
    case "dragon-quest-slime":
      return (
        <>
          <rect x="56" y="16" width="16" height="15" fill="#80c4ef" />
          <rect x="42" y="31" width="44" height="13" fill="#69aee2" />
          <rect x="29" y="44" width="70" height="43" fill="#5aa0d8" />
          <rect x="39" y="87" width="50" height="12" fill="#4384ba" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={47} rightX={76} y={55} mouthX={58} mouthY={72} mouthWidth={14} mouthHeight={5} mouthColor="#c4444a" mouthStyle="smile" />
          <rect x="58" y="72" width="14" height="5" fill="#c4444a" />
        </>
      );
    case "inkling":
      return (
        <>
          <rect x="50" y="13" width="11" height="28" fill="#61c3b8" />
          <rect x="67" y="13" width="11" height="28" fill="#61c3b8" />
          <rect x="38" y="31" width="52" height="43" fill="#54afa2" />
          <rect x="32" y="72" width="15" height="29" fill="#54afa2" />
          <rect x="56" y="72" width="15" height="29" fill="#3f9188" />
          <rect x="81" y="72" width="15" height="29" fill="#3f9188" />
          <rect x="41" y="78" width="46" height="17" fill="#25292f" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={48} rightX={74} y={45} />
        </>
      );
    case "snoopy":
      return (
        <>
          <rect x="42" y="23" width="36" height="9" fill="#fffaf0" />
          <rect x="34" y="32" width="55" height="14" fill="#fffaf0" />
          <rect x="32" y="46" width="61" height="18" fill="#f4f1e8" />
          <rect x="43" y="64" width="43" height="10" fill="#e6dfd2" />
          <rect x="82" y="39" width="20" height="10" fill="#fffaf0" />
          <rect x="92" y="49" width="17" height="12" fill="#fffaf0" />
          <rect x="101" y="43" width="11" height="10" fill="#1f1f22" />
          <rect x="106" y="48" width="7" height="8" fill="#1f1f22" />
          <rect x="23" y="31" width="18" height="14" fill="#1f1f22" />
          <rect x="19" y="45" width="23" height="30" fill="#1f1f22" />
          <rect x="23" y="75" width="16" height="12" fill="#1f1f22" />
          <rect x="28" y="36" width="7" height="31" fill="#373234" />
          <rect x="39" y="74" width="50" height="7" fill="#d84c43" />
          <rect x="42" y="81" width="51" height="22" fill="#fffaf0" />
          <rect x="35" y="88" width="12" height="18" fill="#fffaf0" />
          <rect x="88" y="82" width="13" height="13" fill="#fffaf0" />
          <rect x="98" y="79" width="8" height="8" fill="#fffaf0" />
          <rect x="48" y="101" width="11" height="6" fill="#e6dfd2" />
          <rect x="75" y="101" width="11" height="6" fill="#e6dfd2" />
          <rect className="cloud-code-monster-pet-left-foot" x="36" y="104" width="24" height="10" fill="#fffaf0" />
          <rect className="cloud-code-monster-pet-right-foot" x="70" y="104" width="24" height="10" fill="#fffaf0" />
          <rect x="36" y="112" width="24" height="4" fill="#e6dfd2" />
          <rect x="70" y="112" width="24" height="4" fill="#e6dfd2" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={61} rightX={61} y={43} color="#1f1f22" highlightColor="#fffaf0" singleEye mouthX={86} mouthY={59} mouthWidth={11} mouthHeight={3} mouthColor="#1f1f22" mouthStyle="flat" />
        </>
      );
    case "chopper":
      return (
        <>
          <rect x="32" y="19" width="14" height="8" fill="#b07d55" />
          <rect x="82" y="19" width="14" height="8" fill="#b07d55" />
          <rect x="27" y="25" width="13" height="30" fill="#b07d55" />
          <rect x="88" y="25" width="13" height="30" fill="#b07d55" />
          <rect x="38" y="19" width="52" height="19" fill="#df84b2" />
          <rect x="48" y="10" width="32" height="15" fill="#df84b2" />
          <rect x="38" y="38" width="52" height="39" fill="#bd7d55" />
          <rect x="45" y="54" width="38" height="22" fill="#f0cba6" />
          <rect x="36" y="77" width="56" height="27" fill="#c95b70" />
          <rect className="cloud-code-monster-pet-left-foot" x="39" y="104" width="18" height="10" fill="#bd7d55" />
          <rect className="cloud-code-monster-pet-right-foot" x="72" y="104" width="18" height="10" fill="#bd7d55" />
          <DirectPixelEyes activityId={activityId} preset={preset} reacting={reacting} shaken={shaken} fainted={fainted} leftX={49} rightX={75} y={49} />
        </>
      );
    default:
      return null;
  }
}

function MonsterStaticBody({
  preset,
  activityId,
  animated = false,
  reacting = false,
  shaken = false,
  fainted = false,
}: {
  preset: CloudCodeMonsterPetPreset;
  activityId: CloudCodeMonsterActivityId | null;
  animated?: boolean;
  reacting?: boolean;
  shaken?: boolean;
  fainted?: boolean;
}) {
  const shape = preset.shape ?? "monster";

  if (shape !== "monster") {
    return (
      <g className={animated ? "cloud-code-monster-pet-character" : undefined}>
        <MonsterDirectPixelCharacter
          activityId={activityId}
          preset={preset}
          reacting={reacting}
          shaken={shaken}
          fainted={fainted}
        />
      </g>
    );
  }

  return (
    <g className={animated ? "cloud-code-monster-pet-character" : undefined}>
      <MonsterPresetFeature preset={preset} />
      <rect x="36" y="27" width="56" height="10" fill={preset.bodyTop} />
      <rect x="28" y="37" width="72" height="14" fill={preset.bodyTop} />
      <rect x="16" y="51" width="12" height="24" fill={preset.body} />
      <rect x="28" y="51" width="72" height="45" fill={preset.body} />
      <rect x="100" y="51" width="12" height="24" fill={preset.body} />
      <rect x="16" y="63" width="12" height="12" fill={preset.bodyDark} />
      <rect x="28" y="84" width="72" height="12" fill={preset.bodyDark} />
      <rect x="36" y="37" width="56" height="5" fill={preset.bodyLight} />
      <rect x="28" y="51" width="8" height="33" fill={preset.bodySideLight} />
      <rect x="92" y="51" width="8" height="33" fill={preset.bodySideDark} />
      <MonsterPresetBodyMarks preset={preset} />
      <MonsterEyes
        activityId={activityId}
        preset={preset}
        reacting={reacting}
        shaken={shaken}
        fainted={fainted}
      />
      <rect x="36" y="69" width="8" height="8" fill={preset.bodyLight} />
      <rect x="84" y="69" width="8" height="8" fill={preset.bodySideDark} />
      <rect
        className="cloud-code-monster-pet-left-foot"
        x="29"
        y="96"
        width="12"
        height="22"
        fill={preset.body}
      />
      <rect
        className="cloud-code-monster-pet-left-foot"
        x="52"
        y="96"
        width="12"
        height="22"
        fill={preset.body}
      />
      <rect
        className="cloud-code-monster-pet-right-foot"
        x="76"
        y="96"
        width="12"
        height="22"
        fill={preset.bodyDark}
      />
      <rect
        className="cloud-code-monster-pet-right-foot"
        x="96"
        y="96"
        width="12"
        height="22"
        fill={preset.bodyDark}
      />
    </g>
  );
}

export function CloudCodeMonsterPresetPreview({
  preset,
  className,
}: {
  preset: CloudCodeMonsterPetPreset;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 128 128"
      role="img"
      aria-label={`${preset.name} pixel PET preset`}
      shapeRendering="crispEdges"
    >
      <rect x="31" y="116" width="66" height="5" fill="rgba(45,40,36,.12)" />
      <rect x="40" y="121" width="48" height="3" fill="rgba(45,40,36,.07)" />
      <MonsterStaticBody preset={preset} activityId={null} />
    </svg>
  );
}

function MonsterSvg({
  activityId,
  preset,
  reacting,
  shaken,
  fainted,
}: {
  activityId: CloudCodeMonsterActivityId | null;
  preset: CloudCodeMonsterPetPreset;
  reacting: boolean;
  shaken: boolean;
  fainted: boolean;
}) {
  const expression = getCloudCodeMonsterExpression(
    activityId,
    reacting,
    shaken,
    fainted
  );
  const isShocked = expression === "shocked" || expression === "shaken";

  return (
    <svg
      className="cloud-code-monster-pet-svg"
      viewBox="0 0 128 128"
      role="img"
      aria-label={`Claude Code style pixel monster ${activityId ?? "idle"}`}
      shapeRendering="crispEdges"
    >
      <rect x="31" y="116" width="66" height="5" fill="rgba(45,40,36,.14)" />
      <rect x="40" y="121" width="48" height="3" fill="rgba(45,40,36,.08)" />
      {isShocked ? (
        <g className="cloud-code-monster-pet-shock" aria-hidden="true">
          <rect x="17" y="15" width="7" height="17" fill={preset.accent} />
          <rect x="103" y="13" width="7" height="17" fill={preset.accent} />
          <rect x="61" y="4" width="7" height="16" fill={preset.accent} />
          <rect x="19" y="91" width="16" height="6" fill={preset.accessory} />
          <rect x="94" y="91" width="16" height="6" fill={preset.accessory} />
        </g>
      ) : null}
      <MonsterStaticBody
        preset={preset}
        activityId={activityId}
        animated
        reacting={reacting}
        shaken={shaken}
        fainted={fainted}
      />
      <MonsterActivityAccessory
        activityId={fainted ? null : activityId}
        preset={preset}
      />
    </svg>
  );
}

type CloudCodeMonsterPetProps = {
  boundaryRef: RefObject<HTMLElement | null>;
  initialPosition?: PetPoint;
  activityTriggerMode?: CloudCodeMonsterActivityTriggerMode;
  previewComebackToken?: number;
  notificationToken?: number;
  peekTargets?: CloudCodeMonsterPeekTarget[];
};

export function CloudCodeMonsterPet({
  boundaryRef,
  initialPosition,
  activityTriggerMode = "global",
  previewComebackToken = 0,
  notificationToken = 0,
  peekTargets = [],
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
  const reactionTimerRef = useRef<number | null>(null);
  const shakeTimerRef = useRef<number | null>(null);
  const faintTimerRef = useRef<number | null>(null);
  const autonomousWalkTimerRef = useRef<number | null>(null);
  const autonomousWalkStopTimerRef = useRef<number | null>(null);
  const peekTimerRef = useRef<number | null>(null);
  const peekStopTimerRef = useRef<number | null>(null);
  const notificationTimerRef = useRef<number | null>(null);
  const walkSettleTimerRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const violentDragEventsRef = useRef<number[]>([]);

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
    return () => {
      if (reactionTimerRef.current) {
        window.clearTimeout(reactionTimerRef.current);
      }
      if (shakeTimerRef.current) {
        window.clearTimeout(shakeTimerRef.current);
      }
      if (faintTimerRef.current) {
        window.clearTimeout(faintTimerRef.current);
      }
      if (autonomousWalkTimerRef.current) {
        window.clearTimeout(autonomousWalkTimerRef.current);
        autonomousWalkTimerRef.current = null;
      }
      if (autonomousWalkStopTimerRef.current) {
        window.clearTimeout(autonomousWalkStopTimerRef.current);
      }
      if (peekTimerRef.current) {
        window.clearTimeout(peekTimerRef.current);
      }
      if (peekStopTimerRef.current) {
        window.clearTimeout(peekStopTimerRef.current);
      }
      if (notificationTimerRef.current) {
        window.clearTimeout(notificationTimerRef.current);
      }
      if (walkSettleTimerRef.current) {
        window.clearTimeout(walkSettleTimerRef.current);
      }
    };
  }, []);

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
  const shouldAutoWalk = shouldCloudCodeMonsterAutoWalk(
    activityState?.activityId ?? null
  );

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
      autonomousWalkTimerRef.current = window.setTimeout(() => {
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

    autonomousWalkTimerRef.current = window.setTimeout(
      scheduleNextWalkStep,
      CLOUD_CODE_MONSTER_AUTO_WALK_STEP_MS
    );

    return () => {
      if (autonomousWalkTimerRef.current) {
        window.clearTimeout(autonomousWalkTimerRef.current);
        autonomousWalkTimerRef.current = null;
      }
    };
  }, [
    activityState?.activityId,
    boundaryRef,
    fainted,
    hasPosition,
    isDragging,
    isPeeking,
    reacting,
    shaken,
    shouldAutoWalk,
  ]);

  useEffect(() => {
    if (
      !position ||
      peekTargets.length === 0 ||
      isDragging ||
      reacting ||
      shaken ||
      fainted
    ) {
      return;
    }

    peekTimerRef.current = window.setTimeout(() => {
      const target =
        peekTargets[Math.floor(Math.random() * peekTargets.length)] ??
        peekTargets[0];

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

      peekStopTimerRef.current = window.setTimeout(() => {
        setIsPeeking(false);
        peekStopTimerRef.current = null;
      }, CLOUD_CODE_MONSTER_PEEK_MS);
    }, CLOUD_CODE_MONSTER_PEEK_INTERVAL_MS + Math.random() * 4_000);

    return () => {
      if (peekTimerRef.current) {
        window.clearTimeout(peekTimerRef.current);
        peekTimerRef.current = null;
      }
    };
  }, [
    boundaryRef,
    fainted,
    isDragging,
    peekTargets,
    position,
    reacting,
    shaken,
  ]);

  const pushFootprint = (nextPosition: PetPoint, intensity: number) => {
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
  };

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

    if (autonomousWalkStopTimerRef.current) {
      window.clearTimeout(autonomousWalkStopTimerRef.current);
      autonomousWalkStopTimerRef.current = null;
    }
    if (peekStopTimerRef.current) {
      window.clearTimeout(peekStopTimerRef.current);
      peekStopTimerRef.current = null;
    }
  };

  const startShockReaction = () => {
    if (reactionTimerRef.current) {
      window.clearTimeout(reactionTimerRef.current);
    }

    setReacting(true);
    reactionTimerRef.current = window.setTimeout(() => {
      setReacting(false);
      reactionTimerRef.current = null;
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

    if (notificationTimerRef.current) {
      window.clearTimeout(notificationTimerRef.current);
    }
    notificationTimerRef.current = window.setTimeout(() => {
      setNotificationActive(false);
      notificationTimerRef.current = null;
    }, CLOUD_CODE_MONSTER_REACTION_MS + 1_500);
  }, [notificationToken]);

  const startShakeReaction = () => {
    if (fainted) {
      return;
    }

    if (activityState?.activityId) {
      wakeMonsterToDefault();
    }

    if (shakeTimerRef.current) {
      window.clearTimeout(shakeTimerRef.current);
    }

    setShaken(true);
    shakeTimerRef.current = window.setTimeout(() => {
      setShaken(false);
      shakeTimerRef.current = null;
    }, CLOUD_CODE_MONSTER_SHAKE_REACTION_MS);
  };

  const startFaintReaction = () => {
    if (faintTimerRef.current) {
      window.clearTimeout(faintTimerRef.current);
    }
    if (reactionTimerRef.current) {
      window.clearTimeout(reactionTimerRef.current);
      reactionTimerRef.current = null;
    }
    if (shakeTimerRef.current) {
      window.clearTimeout(shakeTimerRef.current);
      shakeTimerRef.current = null;
    }

    wakeMonsterToDefault();
    stopTemporaryMotion();
    setReacting(false);
    setShaken(false);
    setFainted(true);
    setWalkIntensity(1);

    faintTimerRef.current = window.setTimeout(() => {
      setFainted(false);
      faintTimerRef.current = null;
    }, CLOUD_CODE_MONSTER_FAINT_MS);
  };

  const handlePetClick = () => {
    stopTemporaryMotion();
    setNotificationActive(false);
    if (notificationTimerRef.current) {
      window.clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }

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
      if (faintTimerRef.current) {
        window.clearTimeout(faintTimerRef.current);
        faintTimerRef.current = null;
      }
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

    if (walkSettleTimerRef.current) {
      window.clearTimeout(walkSettleTimerRef.current);
    }
    walkSettleTimerRef.current = window.setTimeout(() => {
      setWalkIntensity(1);
      walkSettleTimerRef.current = null;
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
    <>
      <div className="cloud-code-monster-pet-footsteps" aria-hidden="true">
        {footprints.map((footprint) => (
          <span
            key={footprint.id}
            className="cloud-code-monster-pet-footprint"
            data-side={footprint.side}
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
            ? "晕倒"
            : isPeeking
              ? "偷看工作"
              : displayedActivity?.label ?? "默认状态"
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
              ? "晕倒"
              : isPeeking
                ? "偷看工作"
                : displayedActivity?.label ?? "默认状态"
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
    </>
  );
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  calculateMonsterWalkIntensity,
  clampMonsterSpriteEyeOffset,
  clampPetPosition,
  CloudCodeMonsterPresetPreview,
  CLOUD_CODE_MONSTER_ACTIVITIES,
  CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
  CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS,
  CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS,
  CLOUD_CODE_MONSTER_FAINT_MS,
  CLOUD_CODE_MONSTER_NO_WORK_SLEEP_MS,
  CLOUD_CODE_MONSTER_PET_PRESETS,
  createCloudCodeMonsterHiddenState,
  createCloudCodeMonsterIdleState,
  createCloudCodeMonsterSleepingState,
  createCloudCodeMonsterWalkVelocity,
  createWalkToTargetVelocity,
  getCloudCodeMonsterExpression,
  getCloudCodeMonsterPreset,
  getMonsterFootstepIntervalMs,
  hasViolentMonsterDirectionChange,
  isViolentMonsterDrag,
  pickCloudCodeMonsterActivity,
  reflectCloudCodeMonsterWalk,
  EMPTY_CLOUD_CODE_MONSTER_CURSOR_POSE,
  resolveCloudCodeMonsterAgentWorkState,
  resolveCloudCodeMonsterActivityState,
  resolveCloudCodeMonsterCursorPose,
  resolveCloudCodeMonsterEyeOffset,
  resolveCloudCodeMonsterPreviewEyeOffset,
  resolveCloudCodeMonsterPeekPosition,
  resolveCloudCodeMonsterPreviewComebackState,
  resolveCloudCodeMonsterVisibleState,
  resolvePetSpriteRowId,
  PET_SPRITE_ROW_BY_ID,
  PET_SPRITE_ROWS,
  petSpriteBodyUrl,
  petSpriteEyesUrl,
  shouldCloudCodeMonsterAutoWalk,
  shouldFaintFromMonsterShake,
  shouldRefreshCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet";
import { usePetDrag } from "./cloud-code-monster-pet-drag";
import type { CloudCodeMonsterActivityId } from "./cloud-code-monster-pet-types";
import { readHomePetSettings } from "../../lib/home-pet-settings";

vi.mock("./cloud-code-monster-pet.module.css", () => ({
  default: {
    petLayer: "petLayer",
    sprite: "sprite",
    spritePreview: "spritePreview",
    spriteShadow: "spriteShadow",
    spriteCharacter: "spriteCharacter",
    spriteSheet: "spriteSheet",
    spriteEyes: "spriteEyes",
  },
}));

function webRoot() {
  return process.cwd().endsWith(`${path.sep}src${path.sep}web`)
    ? process.cwd()
    : path.join(process.cwd(), "src/web");
}

type GeneratedPng = {
  width: number;
  height: number;
  rgba: Buffer;
};

function readGeneratedPng(assetName: string): GeneratedPng {
  const png = readFileSync(path.join(webRoot(), "public/pets", assetName));
  let width = 0;
  let height = 0;
  const idatChunks: Buffer[] = [];

  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const rgba = Buffer.alloc(width * height * 4);
  const sourceStride = 1 + width * 4;
  for (let y = 0; y < height; y++) {
    expect(raw[y * sourceStride]).toBe(0);
    raw.copy(
      rgba,
      y * width * 4,
      y * sourceStride + 1,
      y * sourceStride + 1 + width * 4
    );
  }

  return { width, height, rgba };
}

function logicalRgba(png: GeneratedPng, logicalX: number, logicalY: number) {
  const scale = 4;
  const x = logicalX * scale + 1;
  const y = logicalY * scale + 1;
  const i = (y * png.width + x) * 4;
  return Array.from(png.rgba.subarray(i, i + 4));
}

function logicalFrameAlphaBounds(
  png: GeneratedPng,
  frameOffsetX: number,
  rowOffsetY: number
) {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (logicalRgba(png, frameOffsetX + x, rowOffsetY + y)[3] === 0) {
        continue;
      }

      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }

  return {
    left,
    right,
    top,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

function rgbaMatches(actual: number[], expected: readonly number[]) {
  return expected.every((v, i) => v === actual[i]);
}

function logicalFrameColorBounds(
  png: GeneratedPng,
  frameOffsetX: number,
  rowOffsetY: number,
  colors: readonly (readonly number[])[]
) {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const actual = logicalRgba(png, frameOffsetX + x, rowOffsetY + y);
      if (!colors.some((color) => rgbaMatches(actual, color))) {
        continue;
      }

      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }

  return {
    left,
    right,
    top,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

const DUST_CREAM_RGBA = [0xf5, 0xef, 0xda, 0xff] as const;
const DUST_INK_RGBA = [0x15, 0x15, 0x1a, 0xff] as const;
const SPARK_BOLT_INK_RGBA = [0x24, 0x1c, 0x12, 0xff] as const;
const PEEK_GHOST_BODY_RGBA = [0xe4, 0xe9, 0xf6, 0xff] as const;
const PEEK_GHOST_MOUTH_RGBA = [0xec, 0x61, 0x89, 0xff] as const;
const PEEK_GHOST_MOUTH_DEEP_RGBA = [0xc2, 0x3a, 0x60, 0xff] as const;
const BLINK_HISS_SCLERA_RGBA = [0xf2, 0xf6, 0xe4, 0xff] as const;
const BLINK_HISS_INK_RGBA = [0x16, 0x18, 0x12, 0xff] as const;
const BLINK_HISS_BODY_RGBA = [0x5c, 0xb1, 0x4c, 0xff] as const;
const BLINK_HISS_DARK_RGBA = [0x44, 0x9a, 0x3c, 0xff] as const;
const BLINK_HISS_MOSS_RGBA = [0x6f, 0xc0, 0x5c, 0xff] as const;
const BLINK_HISS_STEM_RGBA = [0x33, 0x77, 0x3a, 0xff] as const;
const BLINK_HISS_IRIS_RGBA = [0x2f, 0x7d, 0x33, 0xff] as const;
const BLINK_HISS_HIGHLIGHT_RGBA = [0xdf, 0xf0, 0xd0, 0xff] as const;
const BLINK_HISS_SNORE_MID_RGBA = [0xd4, 0xcc, 0xb9, 0xff] as const;
const BLINK_HISS_SNORE_DARK_RGBA = [0xa3, 0x98, 0x84, 0xff] as const;

function expectDustSquareEyeSocketAt(
  png: GeneratedPng,
  centerX: number,
  centerY: number
) {
  const cornerOffsets = new Set(["-3,-3", "2,-3", "-3,2", "2,2"]);

  for (let dy = -3; dy <= 2; dy++) {
    for (let dx = -3; dx <= 2; dx++) {
      const actual = logicalRgba(png, centerX + dx, centerY + dy);
      if (cornerOffsets.has(`${dx},${dy}`)) {
        expect(actual).toEqual(DUST_INK_RGBA);
      } else {
        expect(actual).toEqual(DUST_CREAM_RGBA);
      }
    }
  }

  for (let dx = -3; dx <= 2; dx++) {
    expect(logicalRgba(png, centerX + dx, centerY - 4)).not.toEqual(
      DUST_CREAM_RGBA
    );
    expect(logicalRgba(png, centerX + dx, centerY + 3)).not.toEqual(
      DUST_CREAM_RGBA
    );
  }

  for (let dy = -3; dy <= 2; dy++) {
    expect(logicalRgba(png, centerX - 4, centerY + dy)).not.toEqual(
      DUST_CREAM_RGBA
    );
    expect(logicalRgba(png, centerX + 3, centerY + dy)).not.toEqual(
      DUST_CREAM_RGBA
    );
  }
}

function expectDustCenteredPupilAt(
  png: GeneratedPng,
  frameOffsetX: number,
  centerX: number,
  centerY: number
) {
  for (let dy = -2; dy <= 1; dy++) {
    for (let dx = -2; dx <= 1; dx++) {
      const actual = logicalRgba(
        png,
        frameOffsetX + centerX + dx,
        centerY + dy
      );
      const isPupil = dx >= -1 && dx <= 0 && dy >= -1 && dy <= 0;
      if (isPupil) {
        expect(actual).toEqual(DUST_INK_RGBA);
      } else {
        expect(actual[3]).toBe(0);
      }
    }
  }
}

function expectBlinkHissCyclopsScleraAt(
  png: GeneratedPng,
  centerX: number,
  centerY: number
) {
  for (let dy = -4; dy <= 4; dy++) {
    const absDy = Math.abs(dy);
    const halfWidth = absDy === 4 ? 2 : absDy === 3 ? 3 : 4;
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      expect(logicalRgba(png, centerX + dx, centerY + dy)).toEqual(
        BLINK_HISS_SCLERA_RGBA
      );
    }
  }
}

function blinkHissEyeCoreRgba(dx: number, dy: number) {
  if (dx === 1 && dy === -2) return BLINK_HISS_HIGHLIGHT_RGBA;
  if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) {
    return BLINK_HISS_INK_RGBA;
  }
  if (dx >= -1 && dx <= 1 && dy >= -2 && dy <= 2) {
    return BLINK_HISS_IRIS_RGBA;
  }
  if ((dx === -2 || dx === 2) && dy >= -1 && dy <= 1) {
    return BLINK_HISS_IRIS_RGBA;
  }
  return null;
}

function blinkHissEyeCoreOffsets() {
  const offsets: Array<[number, number]> = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (blinkHissEyeCoreRgba(dx, dy)) offsets.push([dx, dy]);
    }
  }
  return offsets;
}

function expectBlinkHissPreviousStyleEyeCoreAt(
  png: GeneratedPng,
  frameOffsetX: number,
  centerX: number,
  centerY: number
) {
  let corePixels = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const actual = logicalRgba(
        png,
        frameOffsetX + centerX + dx,
        centerY + dy
      );
      const expected = blinkHissEyeCoreRgba(dx, dy);
      if (expected) {
        corePixels += 1;
        expect(actual).toEqual(expected);
      } else {
        expect(actual[3]).toBe(0);
      }
    }
  }
  expect(corePixels).toBe(21);
}

function expectBlinkHissEyeOverlayFrameUsesOnlyCoreColors(
  png: GeneratedPng,
  frameIndex: number
) {
  const allowedColors = [
    BLINK_HISS_INK_RGBA,
    BLINK_HISS_IRIS_RGBA,
    BLINK_HISS_HIGHLIGHT_RGBA,
  ];
  let opaquePixels = 0;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const actual = logicalRgba(png, frameIndex * 32 + x, y);
      if (actual[3] === 0) continue;
      opaquePixels += 1;
      expect(
        allowedColors.some((color) => color.every((v, i) => v === actual[i]))
      ).toBe(true);
      expect(actual).not.toEqual(BLINK_HISS_SCLERA_RGBA);
    }
  }
  expect(opaquePixels).toBeGreaterThan(0);
}

function expectBlinkHissEyeCoreFitsInsideScleraAtMaxOffsets(
  png: GeneratedPng,
  centerX: number,
  centerY: number
) {
  const maxOffsets = [
    [-2, -1],
    [-2, 1],
    [2, -1],
    [2, 1],
  ] as const;

  for (const [offsetX, offsetY] of maxOffsets) {
    for (const [dx, dy] of blinkHissEyeCoreOffsets()) {
      expect(
        logicalRgba(png, centerX + offsetX + dx, centerY + offsetY + dy)
      ).toEqual(BLINK_HISS_SCLERA_RGBA);
    }
  }
}

function renderDragHarness(activityId: CloudCodeMonsterActivityId | null) {
  let handlers: ReturnType<typeof usePetDrag> | null = null;
  const wakeMonsterToDefault = vi.fn();
  const stopTemporaryMotion = vi.fn();
  const setIsDragging = vi.fn();
  const startShockReaction = vi.fn();

  function DragHarness() {
    handlers = usePetDrag({
      boundaryRef: { current: null },
      position: { x: 120, y: 140 },
      isDragging: false,
      fainted: false,
      activityState: { activityId, updatedAt: 1_000, hiddenAt: null },
      lastFootstepAtRef: { current: 0 },
      violentDragEventsRef: { current: [] },
      setIsDragging,
      setNotificationActive: vi.fn(),
      setFainted: vi.fn(),
      setWalkDirection: vi.fn(),
      setWalkIntensity: vi.fn(),
      setPosition: vi.fn(),
      clearPetTimer: vi.fn(),
      setPetTimer: vi.fn(),
      pushFootprint: vi.fn(),
      stopTemporaryMotion,
      wakeMonsterToDefault,
      startShockReaction,
      startShakeReaction: vi.fn(),
      startFaintReaction: vi.fn(),
    });

    return null;
  }

  renderToString(createElement(DragHarness));

  if (!handlers) {
    throw new Error("drag harness did not render");
  }

  return {
    handlers,
    setIsDragging,
    startShockReaction,
    stopTemporaryMotion,
    wakeMonsterToDefault,
  };
}

describe("Cloud Code monster PET helpers", () => {
  it("keeps the PET inside the provided bounds", () => {
    expect(
      clampPetPosition(
        { x: -40, y: 900 },
        { width: 500, height: 400 },
        { width: 120, height: 140 },
        12
      )
    ).toEqual({ x: 12, y: 248 });
  });

  it("keeps production presets selectable and validates fallback behavior", () => {
    const presetIds = new Set(CLOUD_CODE_MONSTER_PET_PRESETS.map((preset) => preset.id));
    const publicNames = CLOUD_CODE_MONSTER_PET_PRESETS.map((preset) => preset.name);
    const publicGroups = CLOUD_CODE_MONSTER_PET_PRESETS.map((preset) => preset.group);
    const sensitiveNames = [
      "Doraemon",
      "Pikachu",
      "Kirby",
      "Bulbasaur",
      "Charmander",
      "Squirtle",
      "Minecraft Steve",
      "Minecraft Creeper",
      "Minecraft Zombie",
      "Toad",
      "Sonic",
      "Pac-Man",
      "Boo",
      "Mario",
      "Winnie the Pooh",
      "Hello Kitty",
      "My Melody",
      "Kuromi",
      "Totoro",
      "Soot Sprite",
      "Luffy",
      "Naruto",
      "Goku",
      "Sailor Moon",
      "Gundam",
      "Dragon Quest Slime",
      "Inkling",
      "Snoopy",
      "Chopper",
    ];

    expect(CLOUD_CODE_MONSTER_PET_PRESETS).toHaveLength(6);
    expect([...presetIds]).toEqual([
      "pet-1",
      "pet-2",
      "pet-3",
      "pet-4",
      "pet-5",
      "pet-6",
    ]);
    expect(presetIds.size).toBe(6);
    expect(publicNames).not.toEqual(expect.arrayContaining(sensitiveNames));
    expect(publicGroups).not.toContain("Licensed IP");
    expect(getCloudCodeMonsterPreset("pet-12").id).toBe("pet-1");
    expect(getCloudCodeMonsterPreset("pet-6").id).toBe("pet-6");
    expect(getCloudCodeMonsterPreset("missing").id).toBe(
      CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id
    );
  });

  it("defaults to opt-in behavior", () => {
    expect(readHomePetSettings()).toMatchObject({
      enabled: false,
    });
  });

  it("refreshes visible activity only after the away threshold", () => {
    const updatedAt = 1_000;

    expect(CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS).toBe(3 * 60 * 1000);
    expect(
      shouldRefreshCloudCodeMonsterActivity(
        updatedAt,
        updatedAt + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS - 1
      )
    ).toBe(false);
    expect(
      shouldRefreshCloudCodeMonsterActivity(
        updatedAt,
        updatedAt + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS
      )
    ).toBe(true);

    const visible = resolveCloudCodeMonsterVisibleState(
      { activityId: "coding", updatedAt, hiddenAt: updatedAt },
      updatedAt + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS - 1,
      0.99
    );

    expect(visible).toEqual({
      activityId: "coding",
      updatedAt,
      hiddenAt: null,
    });

    expect(
      resolveCloudCodeMonsterVisibleState(
        { activityId: "coding", updatedAt, hiddenAt: updatedAt },
        updatedAt + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS
      )
    ).toEqual({
      activityId: null,
      updatedAt: updatedAt + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
      hiddenAt: null,
    });
    expect(resolveCloudCodeMonsterVisibleState(null, 4_000)).toEqual({
      activityId: null,
      updatedAt: 4_000,
      hiddenAt: null,
    });
    expect(resolveCloudCodeMonsterPreviewComebackState(7_000)).toEqual({
      activityId: null,
      updatedAt: 7_000,
      hiddenAt: null,
    });
  });

  it("tracks idle, hidden, and deterministic activity states", () => {
    expect(createCloudCodeMonsterIdleState(8_000)).toEqual({
      activityId: null,
      updatedAt: 8_000,
      hiddenAt: null,
    });
    expect(
      createCloudCodeMonsterHiddenState(
        { activityId: null, updatedAt: 1_000, hiddenAt: null },
        2_000
      )
    ).toEqual({
      activityId: null,
      updatedAt: 1_000,
      hiddenAt: 2_000,
    });
    expect(pickCloudCodeMonsterActivity(0).id).toBe(
      CLOUD_CODE_MONSTER_ACTIVITIES[0]!.id
    );
    expect(pickCloudCodeMonsterActivity(0.999).id).toBe("yawning");
    expect(createCloudCodeMonsterSleepingState(9_000)).toEqual({
      activityId: "sleeping",
      updatedAt: 9_000,
      hiddenAt: null,
    });
    expect(
      resolveCloudCodeMonsterActivityState(
        { activityId: "coding", updatedAt: 1_000, hiddenAt: null },
        1_100
      )
    ).toEqual({ activityId: "coding", updatedAt: 1_000, hiddenAt: null });
    expect(
      resolveCloudCodeMonsterActivityState(
        { activityId: "coding", updatedAt: 1_000, hiddenAt: null },
        1_000 + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS
      )
    ).toEqual({
      activityId: null,
      updatedAt: 1_000 + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
      hiddenAt: null,
    });
  });

  it("maps Alook active agent tasks into working and sleep-ready PET states", () => {
    expect(CLOUD_CODE_MONSTER_NO_WORK_SLEEP_MS).toBe(60_000);
    expect(resolveCloudCodeMonsterAgentWorkState(1, null, 10_000)).toEqual({
      activityId: "coding",
      updatedAt: 10_000,
      hiddenAt: null,
    });
    expect(
      resolveCloudCodeMonsterAgentWorkState(
        3,
        { activityId: "sleeping", updatedAt: 1_000, hiddenAt: null },
        10_000
      )
    ).toEqual({
      activityId: "building",
      updatedAt: 10_000,
      hiddenAt: null,
    });
    expect(
      resolveCloudCodeMonsterAgentWorkState(
        0,
        { activityId: "coding", updatedAt: 1_000, hiddenAt: null },
        10_000
      )
    ).toEqual({
      activityId: null,
      updatedAt: 10_000,
      hiddenAt: null,
    });
    const sleeping = { activityId: "sleeping" as const, updatedAt: 1_000, hiddenAt: null };
    expect(resolveCloudCodeMonsterAgentWorkState(0, sleeping, 10_000)).toBe(
      sleeping
    );
    expect(
      resolveCloudCodeMonsterAgentWorkState(
        2,
        { activityId: null, updatedAt: 1_000, hiddenAt: null },
        10_000
      )
    ).toEqual({
      activityId: "juggling",
      updatedAt: 10_000,
      hiddenAt: null,
    });
    expect(
      resolveCloudCodeMonsterAgentWorkState(
        1,
        { activityId: "coding", updatedAt: 1_000, hiddenAt: 900 },
        10_000
      )
    ).toEqual({
      activityId: "coding",
      updatedAt: 1_000,
      hiddenAt: null,
    });
  });

  it("wakes sleepy PET states from click or pointer down before dragging", () => {
    vi.stubGlobal("window", { innerWidth: 900, innerHeight: 700 });

    const clickHarness = renderDragHarness("sleeping");
    clickHarness.handlers.handlePetClick();

    expect(clickHarness.wakeMonsterToDefault).toHaveBeenCalledTimes(1);
    expect(clickHarness.startShockReaction).not.toHaveBeenCalled();

    const pointerHarness = renderDragHarness("dozing");
    pointerHarness.handlers.handlePointerDown({
      button: 0,
      clientX: 180,
      clientY: 200,
      pointerId: 1,
      currentTarget: {
        setPointerCapture: vi.fn(),
      },
    } as never);

    // sleeping pets wake *and* start dragging in the same gesture
    expect(pointerHarness.stopTemporaryMotion).toHaveBeenCalledTimes(1);
    expect(pointerHarness.wakeMonsterToDefault).toHaveBeenCalledTimes(1);
    expect(pointerHarness.setIsDragging).toHaveBeenCalledWith(true);

    vi.unstubAllGlobals();
  });

  it("limits autonomous walking to selected activities", () => {
    expect(CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS).toEqual([
      "reading",
      "phone",
      "snacking",
    ]);
    expect(shouldCloudCodeMonsterAutoWalk("reading")).toBe(true);
    expect(shouldCloudCodeMonsterAutoWalk("coding")).toBe(false);
    expect(shouldCloudCodeMonsterAutoWalk(null)).toBe(false);
  });

  it("calculates drag walking, shake, faint, and expression states", () => {
    const slowWalk = calculateMonsterWalkIntensity(4, 40);
    const fastWalk = calculateMonsterWalkIntensity(70, 16);

    expect(fastWalk).toBeGreaterThan(slowWalk);
    expect(getMonsterFootstepIntervalMs(fastWalk)).toBeLessThan(
      getMonsterFootstepIntervalMs(slowWalk)
    );
    expect(isViolentMonsterDrag(10, 40)).toBe(false);
    expect(isViolentMonsterDrag(58, 35)).toBe(true);
    expect(
      hasViolentMonsterDirectionChange({ x: 30, y: 1 }, { x: -28, y: 0 })
    ).toBe(true);
    expect(CLOUD_CODE_MONSTER_FAINT_MS).toBe(10_000);
    expect(
      shouldFaintFromMonsterShake(
        Array.from({ length: CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS }, (_, index) => index * 100),
        600
      )
    ).toBe(true);
    expect(getCloudCodeMonsterExpression("sleeping", false, false)).toBe(
      "sleeping"
    );
    expect(getCloudCodeMonsterExpression("sleeping", true, false)).toBe(
      "shocked"
    );
    expect(getCloudCodeMonsterExpression("phone", true, true, true)).toBe(
      "fainted"
    );
  });

  it("resolves cursor-following eyes plus a gentle body lean/stretch", () => {
    expect(
      resolveCloudCodeMonsterEyeOffset(
        { x: 300, y: 210 },
        { x: 100, y: 100 },
        { width: 82, height: 82 }
      )
    ).toEqual({ x: 3.75, y: 1.25 });
    expect(
      resolveCloudCodeMonsterEyeOffset(
        { x: -80, y: -60 },
        { x: 100, y: 100 },
        { width: 82, height: 82 }
      )
    ).toEqual({ x: -4, y: -2.75 });
    expect(
      resolveCloudCodeMonsterEyeOffset(
        { x: 141, y: 136.9 },
        { x: 100, y: 100 },
        { width: 82, height: 82 }
      )
    ).toEqual({ x: 0, y: 0 });

    expect(
      clampMonsterSpriteEyeOffset(
        { x: 3.75, y: -2.75 },
        getCloudCodeMonsterPreset("pet-4")
      )
    ).toEqual({ x: 2, y: -1 });
    expect(
      clampMonsterSpriteEyeOffset(
        { x: 3.75, y: -2.75 },
        getCloudCodeMonsterPreset("pet-6")
      )
    ).toEqual({ x: 3.75, y: -2.75 });

    const rightPose = resolveCloudCodeMonsterCursorPose(
      { x: 300, y: 210 },
      { x: 100, y: 100 },
      { width: 82, height: 82 }
    );
    expect(rightPose.leanDeg).toBeGreaterThan(0);
    expect(rightPose.shadowShift).toBeGreaterThan(0);

    const abovePose = resolveCloudCodeMonsterCursorPose(
      { x: 141, y: -120 },
      { x: 100, y: 100 },
      { width: 82, height: 82 }
    );
    // cursor above: stand taller (stretch up, narrow slightly)
    expect(abovePose.stretchY).toBeGreaterThan(1);
    expect(abovePose.stretchX).toBeLessThan(1);

    const idlePose = resolveCloudCodeMonsterCursorPose(
      { x: 141, y: 136.9 },
      { x: 100, y: 100 },
      { width: 82, height: 82 }
    );
    expect(idlePose).toEqual(EMPTY_CLOUD_CODE_MONSTER_CURSOR_POSE);
  });

  it("resolves settings preset preview eye offsets against each preview card", () => {
    const bounds = { left: 100, top: 50, width: 80, height: 80 };

    expect(
      resolveCloudCodeMonsterPreviewEyeOffset(
        { x: 140, y: 90 },
        bounds,
        getCloudCodeMonsterPreset("pet-6")
      )
    ).toEqual({ x: 0, y: 0 });

    expect(
      resolveCloudCodeMonsterPreviewEyeOffset(
        { x: 180, y: 90 },
        bounds,
        getCloudCodeMonsterPreset("pet-4")
      )
    ).toEqual({ x: 2, y: 0 });

    expect(
      resolveCloudCodeMonsterPreviewEyeOffset(
        { x: 180, y: 90 },
        bounds,
        getCloudCodeMonsterPreset("pet-6")
      )
    ).toEqual({ x: 5.5, y: 0 });

    expect(
      resolveCloudCodeMonsterPreviewEyeOffset(
        { x: 0, y: 0 },
        { ...bounds, width: 0 },
        getCloudCodeMonsterPreset("pet-6")
      )
    ).toEqual({ x: 0, y: 0 });
  });

  it("forwards preset preview eye offsets into the sprite overlay", () => {
    const preview = renderToString(
      createElement(CloudCodeMonsterPresetPreview, {
        preset: getCloudCodeMonsterPreset("pet-4"),
        eyeOffset: { x: 2, y: -1 },
        className: "size-14",
      })
    );

    expect(preview).toContain("Blink Hiss pixel PET preset");
    expect(preview).toContain("--monster-eye-x:1.28px");
    expect(preview).toContain("--monster-eye-y:-0.64px");
  });

  it("creates autonomous walk velocity and reflects from canvas bounds", () => {
    expect(createCloudCodeMonsterWalkVelocity(0, 3)).toEqual({ x: 3, y: 0 });

    const rightBounce = reflectCloudCodeMonsterWalk(
      { x: 202, y: 40 },
      { x: 4, y: 1 },
      { width: 300, height: 240 },
      { width: 82, height: 82 },
      16
    );

    expect(rightBounce.reflectedX).toBe(true);
    expect(rightBounce.velocity.x).toBeLessThan(0);
    expect(rightBounce.position.x).toBeLessThanOrEqual(202);
  });

  it("resolves peeking coordinates from a real agent node before fallback coordinates", () => {
    const agentNode = {
      dataset: { agentNodeId: "ag_mandy" },
      getBoundingClientRect: () => ({
        left: 260,
        top: 360,
        width: 220,
        height: 96,
      }),
    };
    const boundary = {
      querySelectorAll: () => [agentNode],
      getBoundingClientRect: () => ({ left: 20, top: 40 }),
    } as unknown as HTMLElement;

    expect(
      resolveCloudCodeMonsterPeekPosition(
        { agentId: "ag_mandy", x: 1, y: 1 },
        boundary,
        { width: 900, height: 700 }
      )
    ).toEqual({ x: 329, y: 345.24 });
  });

  it("maps every activity and expression onto a generated sprite row", () => {
    // expressions win over activities
    expect(resolvePetSpriteRowId("phone", { fainted: true })).toBe("faint");
    expect(resolvePetSpriteRowId("coding", { shaken: true })).toBe("shaken");
    expect(resolvePetSpriteRowId("reading", { reacting: true })).toBe("shock");

    // sleeping snores first, then settles into the motionless deep pose
    expect(resolvePetSpriteRowId("sleeping", {})).toBe("sleep");
    expect(resolvePetSpriteRowId("sleeping", { deepSleeping: true })).toBe(
      "sleepDeep"
    );

    // walking keeps autowalk accessories in hand
    expect(resolvePetSpriteRowId(null, { walking: true })).toBe("walk");
    expect(resolvePetSpriteRowId("reading", { walking: true })).toBe("walkRead");
    expect(resolvePetSpriteRowId("phone", { walking: true })).toBe("walkPhone");
    expect(resolvePetSpriteRowId("snacking", { walking: true })).toBe("walkSnack");

    // every activity id resolves to a row present in the manifest
    for (const activity of CLOUD_CODE_MONSTER_ACTIVITIES) {
      const rowId = resolvePetSpriteRowId(activity.id, {});
      expect(rowId).not.toBe("idle");
      expect(PET_SPRITE_ROW_BY_ID.get(rowId)).toBeDefined();
    }
    expect(resolvePetSpriteRowId(null, {})).toBe("idle");

    // manifest invariants: keyframes exist and sheets are addressable
    expect(PET_SPRITE_ROWS.length).toBeGreaterThanOrEqual(21);
    for (const row of PET_SPRITE_ROWS) {
      // idle is a single calm frame (blink only); active rows animate
      expect(row.frames).toBeGreaterThanOrEqual(row.id === "idle" ? 1 : 2);
      expect(row.frameMs).toBeGreaterThan(0);
      expect(["overlay", "baked"]).toContain(row.eyes);
    }
    expect(PET_SPRITE_ROW_BY_ID.get("idle")?.frames).toBe(1);
    // expression rows bake their eyes; ambient rows keep the tracking overlay
    expect(PET_SPRITE_ROW_BY_ID.get("sleep")?.eyes).toBe("baked");
    expect(PET_SPRITE_ROW_BY_ID.get("sleepDeep")?.eyes).toBe("baked");
    expect(PET_SPRITE_ROW_BY_ID.get("faint")?.eyes).toBe("baked");
    expect(PET_SPRITE_ROW_BY_ID.get("idle")?.eyes).toBe("overlay");
    expect(PET_SPRITE_ROW_BY_ID.get("walk")?.eyes).toBe("overlay");

    expect(petSpriteBodyUrl("pet-1")).toBe("/pets/pet-1.png");
    expect(petSpriteEyesUrl("pet-6")).toBe("/pets/pet-6-eyes.png");
  });

  it("ships generated sprite sheets for all six pets", () => {
    const root = webRoot();
    for (const preset of CLOUD_CODE_MONSTER_PET_PRESETS) {
      for (const asset of [`${preset.id}.png`, `${preset.id}-eyes.png`]) {
        const png = readFileSync(path.join(root, "public/pets", asset));
        // PNG signature
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(png.length).toBeGreaterThan(200);
      }
    }
  });

  it("keeps the sixth soot PET square eyes with centered 2x2 pupils", () => {
    expect(CLOUD_CODE_MONSTER_PET_PRESETS[5]).toMatchObject({
      id: "pet-6",
      feature: "soot",
    });

    const body = readGeneratedPng("pet-6.png");
    const eyes = readGeneratedPng("pet-6-eyes.png");
    const idleRow = PET_SPRITE_ROW_BY_ID.get("idle")!;
    const centers = [
      [12, 17],
      [20, 17],
    ] as const;

    expect(logicalFrameAlphaBounds(body, 0, idleRow.index * 32)).toEqual({
      left: 5,
      right: 28,
      top: 8,
      bottom: 26,
      width: 24,
      height: 19,
    });

    const overlayRows = PET_SPRITE_ROWS.filter((row) => row.eyes === "overlay");
    expect(overlayRows.map((row) => row.id)).toContain("carry");

    for (const row of overlayRows) {
      for (let frame = 0; frame < row.frames; frame++) {
        for (const [x, y] of centers) {
          expectDustSquareEyeSocketAt(
            body,
            frame * 32 + x,
            row.index * 32 + y
          );
        }
      }
    }

    for (const [x, y] of centers) {
      expectDustCenteredPupilAt(eyes, 0, x, y);
      expectDustCenteredPupilAt(eyes, 3 * 32, x, y);
    }
  });

  it("keeps the fourth green PET sclera fixed while only the larger eye-core follows", () => {
    expect(CLOUD_CODE_MONSTER_PET_PRESETS[3]).toMatchObject({
      id: "pet-4",
      feature: "leaf",
      eyeOffsetMax: { x: 2, y: 1 },
    });

    const body = readGeneratedPng("pet-4.png");
    const eyes = readGeneratedPng("pet-4-eyes.png");
    const [x, y] = [15, 14] as const;
    const overlayRows = PET_SPRITE_ROWS.filter((row) => row.eyes === "overlay");

    expect(overlayRows.map((row) => row.id)).toContain("carry");
    for (const row of overlayRows) {
      for (let frame = 0; frame < row.frames; frame++) {
        expectBlinkHissCyclopsScleraAt(
          body,
          frame * 32 + x,
          row.index * 32 + y
        );
        expectBlinkHissEyeCoreFitsInsideScleraAtMaxOffsets(
          body,
          frame * 32 + x,
          row.index * 32 + y
        );
      }
    }

    for (let frameIndex = 0; frameIndex < 4; frameIndex++) {
      expectBlinkHissEyeOverlayFrameUsesOnlyCoreColors(eyes, frameIndex);
    }
    expectBlinkHissPreviousStyleEyeCoreAt(eyes, 0, x, y);
    expectBlinkHissPreviousStyleEyeCoreAt(eyes, 3 * 32, x, y);
  });

  it("keeps the fourth green PET snore animation low and close to the mouth", () => {
    const body = readGeneratedPng("pet-4.png");
    const idleRow = PET_SPRITE_ROW_BY_ID.get("idle")!;
    const sleepRow = PET_SPRITE_ROW_BY_ID.get("sleep")!;
    const deepSleepRow = PET_SPRITE_ROW_BY_ID.get("sleepDeep")!;
    const blinkHissBodyColors = [
      BLINK_HISS_BODY_RGBA,
      BLINK_HISS_DARK_RGBA,
      BLINK_HISS_MOSS_RGBA,
      BLINK_HISS_STEM_RGBA,
    ];

    const idleBodyBounds = logicalFrameColorBounds(
      body,
      0,
      idleRow.index * 32,
      blinkHissBodyColors
    );
    const snoreBodyBounds = logicalFrameColorBounds(
      body,
      0,
      sleepRow.index * 32,
      blinkHissBodyColors
    );
    const deepSleepBodyBounds = logicalFrameColorBounds(
      body,
      0,
      deepSleepRow.index * 32,
      blinkHissBodyColors
    );

    expect(snoreBodyBounds.top).toBeGreaterThan(idleBodyBounds.top + 5);
    expect(snoreBodyBounds.height).toBeLessThan(idleBodyBounds.height);
    expect(snoreBodyBounds.bottom).toBe(idleBodyBounds.bottom);
    expect(deepSleepBodyBounds.top).toBeGreaterThan(snoreBodyBounds.top);
    expect(deepSleepBodyBounds.height).toBeLessThan(snoreBodyBounds.height);
    expect(deepSleepBodyBounds.bottom).toBe(idleBodyBounds.bottom);

    for (let frameIndex = 0; frameIndex < 4; frameIndex++) {
      expect(
        logicalFrameAlphaBounds(body, frameIndex * 32, sleepRow.index * 32).top
      ).toBeGreaterThanOrEqual(6);
    }

    const sleepFrameChecks = [
      [0, 23, 20, BLINK_HISS_SCLERA_RGBA],
      [0, 24, 20, BLINK_HISS_SNORE_MID_RGBA],
      [1, 23, 18, BLINK_HISS_SCLERA_RGBA],
      [1, 24, 9, BLINK_HISS_SNORE_DARK_RGBA],
      [2, 24, 15, BLINK_HISS_SCLERA_RGBA],
      [2, 27, 6, BLINK_HISS_SNORE_MID_RGBA],
      [3, 25, 12, BLINK_HISS_SNORE_MID_RGBA],
      [3, 27, 6, BLINK_HISS_SNORE_MID_RGBA],
    ] as const;

    for (const [frameIndex, x, y, color] of sleepFrameChecks) {
      expect(logicalRgba(body, frameIndex * 32 + x, sleepRow.index * 32 + y))
        .toEqual(color);
    }

    expect(
      logicalRgba(body, 23, deepSleepRow.index * 32 + 15)
    ).toEqual(BLINK_HISS_SCLERA_RGBA);
    expect(
      logicalRgba(body, 25, deepSleepRow.index * 32 + 9)
    ).toEqual(BLINK_HISS_SNORE_DARK_RGBA);
    expect(
      logicalRgba(body, 32 + 27, deepSleepRow.index * 32 + 6)
    ).toEqual(BLINK_HISS_SNORE_MID_RGBA);
  });

  it("keeps the second and fourth PET mouths small and non-wavy", () => {
    const sparkBody = readGeneratedPng("pet-2.png");
    const hissBody = readGeneratedPng("pet-4.png");
    const idleRow = PET_SPRITE_ROW_BY_ID.get("idle")!;
    const alertRow = PET_SPRITE_ROW_BY_ID.get("alert")!;

    for (const x of [15, 16, 17]) {
      expect(logicalRgba(sparkBody, x, idleRow.index * 32 + 20)).toEqual(
        SPARK_BOLT_INK_RGBA
      );
      expect(logicalRgba(sparkBody, x, alertRow.index * 32 + 20)).toEqual(
        SPARK_BOLT_INK_RGBA
      );
    }

    for (const [x, y] of [
      [13, 19],
      [14, 20],
      [15, 19],
      [16, 19],
      [17, 19],
    ] as const) {
      expect(logicalRgba(sparkBody, x, idleRow.index * 32 + y)).not.toEqual(
        SPARK_BOLT_INK_RGBA
      );
    }

    for (const x of [14, 15, 16]) {
      expect(logicalRgba(hissBody, x, idleRow.index * 32 + 20)).toEqual(
        BLINK_HISS_INK_RGBA
      );
      expect(logicalRgba(hissBody, x, alertRow.index * 32 + 20)).toEqual(
        BLINK_HISS_INK_RGBA
      );
    }

    for (const [x, y] of [
      [13, 20],
      [14, 19],
      [14, 21],
      [16, 19],
      [16, 21],
      [17, 20],
    ] as const) {
      expect(logicalRgba(hissBody, x, idleRow.index * 32 + y)).not.toEqual(
        BLINK_HISS_INK_RGBA
      );
      expect(logicalRgba(hissBody, x, alertRow.index * 32 + y)).not.toEqual(
        BLINK_HISS_INK_RGBA
      );
    }
  });

  it("keeps the fifth ghost PET mouth slightly lower", () => {
    expect(CLOUD_CODE_MONSTER_PET_PRESETS[4]).toMatchObject({
      id: "pet-5",
      feature: "ghost",
    });

    const ghostBody = readGeneratedPng("pet-5.png");
    const idleRow = PET_SPRITE_ROW_BY_ID.get("idle")!;
    const rowY = idleRow.index * 32;

    // The rounded mouth now begins at y=17 with body-colored corners.
    expect(logicalRgba(ghostBody, 14, rowY + 17)).toEqual(
      PEEK_GHOST_BODY_RGBA
    );
    expect(logicalRgba(ghostBody, 15, rowY + 17)).toEqual(
      PEEK_GHOST_MOUTH_RGBA
    );
    expect(logicalRgba(ghostBody, 16, rowY + 17)).toEqual(
      PEEK_GHOST_MOUTH_RGBA
    );
    expect(logicalRgba(ghostBody, 17, rowY + 17)).toEqual(
      PEEK_GHOST_BODY_RGBA
    );

    expect(logicalRgba(ghostBody, 15, rowY + 18)).toEqual(
      PEEK_GHOST_MOUTH_RGBA
    );
    expect(logicalRgba(ghostBody, 15, rowY + 19)).toEqual(
      PEEK_GHOST_MOUTH_DEEP_RGBA
    );
  });

  it("computes walk-to-target velocity correctly", () => {
    const v = createWalkToTargetVelocity({ x: 0, y: 0 }, { x: 100, y: 0 }, 3.2);
    expect(v.x).toBeCloseTo(3.2);
    expect(v.y).toBeCloseTo(0);

    const diagonal = createWalkToTargetVelocity({ x: 0, y: 0 }, { x: 3, y: 4 }, 5);
    expect(diagonal.x).toBeCloseTo(3);
    expect(diagonal.y).toBeCloseTo(4);

    // Zero distance → zero velocity (NaN safety)
    expect(createWalkToTargetVelocity({ x: 5, y: 5 }, { x: 5, y: 5 }, 3.2)).toEqual({ x: 0, y: 0 });

    // NaN inputs → zero velocity
    expect(createWalkToTargetVelocity({ x: NaN, y: 0 }, { x: 10, y: 0 }, 3.2)).toEqual({ x: 0, y: 0 });
  });
});

describe("production workspace PET mounting", () => {
  it("mounts only production PET surfaces", () => {
    const root = webRoot();
    const workspaceHomePage = readFileSync(
      path.join(root, "src/app/(app)/w/[slug]/home/page.tsx"),
      "utf8"
    );
    const settingsPage = readFileSync(
      path.join(root, "src/app/(app)/w/[slug]/settings/page.tsx"),
      "utf8"
    );
    const petTab = readFileSync(
      path.join(root, "src/app/(app)/w/[slug]/settings/pet-tab.tsx"),
      "utf8"
    );
    const workspaceShell = readFileSync(
      path.join(root, "src/components/workspace-shell.tsx"),
      "utf8"
    );
    const workspacePetLayer = readFileSync(
      path.join(root, "src/components/home-pet/workspace-pet-layer.tsx"),
      "utf8"
    );
    const petComponent = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet.tsx"),
      "utf8"
    );
    const petDragHook = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet-drag.ts"),
      "utf8"
    );
    const petPixelParts = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet-pixel-parts.tsx"),
      "utf8"
    );
    const petTypes = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet-types.ts"),
      "utf8"
    );
    const petPresets = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet-presets.ts"),
      "utf8"
    );
    const petSpriteManifest = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet-sprite-manifest.ts"),
      "utf8"
    );
    const petCssModule = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet.module.css"),
      "utf8"
    );
    const petWalkTarget = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet-walk-target.ts"),
      "utf8"
    );
    const agentNode = readFileSync(
      path.join(root, "src/components/canvas/agent-node.tsx"),
      "utf8"
    );
    const inboxPopover = readFileSync(
      path.join(root, "src/components/inbox-popover.tsx"),
      "utf8"
    );
    const landingPage = readFileSync(
      path.join(root, "src/components/home/home-page.tsx"),
      "utf8"
    );
    const inboxCountContext = readFileSync(
      path.join(root, "src/contexts/inbox-count-context.tsx"),
      "utf8"
    );
    const agentContext = readFileSync(
      path.join(root, "src/contexts/agent-context.tsx"),
      "utf8"
    );
    const globalCss = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
    const clientPetSources = [petTypes, petPresets, petPixelParts, petSpriteManifest].join("\n");
    const sensitiveShapeIds = [
      "dor" + "aemon",
      "pika" + "chu",
      "kir" + "by",
      "bulba" + "saur",
      "char" + "mander",
      "squir" + "tle",
      "mine" + "craft",
      "to" + "ad",
      "son" + "ic",
      "pac" + "man",
      "bo" + "o",
      "mar" + "io",
      "po" + "oh",
      "hello-" + "kitty",
      "my-" + "melody",
      "kur" + "omi",
      "toto" + "ro",
      "soot-" + "sprite",
      "luf" + "fy",
      "nar" + "uto",
      "go" + "ku",
      "sailor-" + "moon",
      "gun" + "dam",
      "dragon-quest-" + "slime",
      "ink" + "ling",
      "snoo" + "py",
      "chop" + "per",
    ];

    // Home page no longer renders pet directly
    expect(workspaceHomePage).not.toContain("CloudCodeMonsterPet");
    expect(workspaceHomePage).not.toContain("useHomePetSettings");
    expect(settingsPage).toContain('{ id: "pet", label: "Pet" }');
    expect(petTab).toContain("Enable pet");
    expect(petTab).not.toContain("Homepage only");
    expect(petTab).not.toContain("Global Display");
    expect(petTab).toContain("CloudCodeMonsterPresetPreview");
    expect(petTab).toContain("cloud-code-monster-pet-presets");
    expect(petTab).toContain("resolveCloudCodeMonsterPreviewEyeOffset");
    expect(petTab).toContain("previewEyeOffsets");
    expect(petTab).toContain("data-pet-preview-eye-tracker");
    expect(petTab).toContain("data-pet-preview-preset-id");
    expect(petTab).toContain("data-pet-selected-note");
    expect(petTab).toContain("Out for work");
    expect(petTab).not.toContain("SELECTED_PRESET_PREVIEW_EYE_KEY");
    expect(petTab).not.toContain("selected-preset-preview");
    expect(petTab).not.toContain('className="size-11"');
    expect(petTab).toContain('window.addEventListener("pointermove"');
    expect(petTab).toContain("handlePagePointerMove");
    expect(petTab).toContain(
      "querySelectorAll<HTMLElement>(PET_PREVIEW_EYE_TRACKER_SELECTOR)"
    );
    expect(petTab).not.toContain("onPointerMove");
    expect(petTab).not.toContain("onPointerLeave");
    expect(petTab).not.toContain("onPointerCancel");
    expect(petTab).toContain("aria-pressed={isSelected}");
    expect(petTab).not.toContain(
      'from "@/components/home-pet/cloud-code-monster-pet";'
    );
    expect(workspaceShell).toContain("WorkspacePetLayer");
    expect(workspaceShell).toContain("RuntimeVersionGate");
    // Pet layer renders on all pages — no displayScope or isHome check
    expect(workspacePetLayer).not.toContain("displayScope");
    expect(workspacePetLayer).not.toContain("isHome");
    expect(workspacePetLayer).toContain("petSettings.enabled");
    expect(workspacePetLayer).toContain("dynamic<CloudCodeMonsterPetProps>");
    expect(inboxCountContext).toContain("notificationToken");
    expect(inboxCountContext).toContain("setNotificationToken((token) => token + 1)");
    expect(inboxCountContext).not.toContain("prevCountRef.current = next");
    expect(workspacePetLayer).toContain("useInboxCount");
    expect(workspacePetLayer).toContain("notificationToken={notificationToken}");
    expect(petComponent).toContain("const EMPTY_PEEK_TARGETS");
    expect(petComponent).toContain("peekTargets = EMPTY_PEEK_TARGETS");
    expect(petComponent).toContain("peekTargetsRef.current = peekTargets");
    expect(petComponent).toContain("const hasPeekTargets = peekTargets.length > 0");
    expect(petComponent).toContain("function usePetTimers()");
    expect(petComponent).toContain("setPetTimer(\"peek\"");
    expect(petComponent).toContain("usePetDrag({");
    expect(petComponent).toContain("useInboxCount");
    expect(petComponent).toContain("lastNotificationTokenRef");
    expect(petComponent).toContain("notificationToken === lastNotificationTokenRef.current");
    expect(petComponent).toContain("isDragging || fainted || notificationActive");
    expect(petComponent).toContain("useWalkToTarget");
    expect(petComponent).toContain("useAgentContextSafe");
    expect(petComponent).toContain("activeTaskDetails");
    expect(petComponent).toContain("hasRunningTasks");
    expect(petComponent).toContain("activeAgentTaskCountRef.current");
    expect(petComponent).toContain('clearPetTimer("attention")');
    expect(petComponent).toContain("resolveCloudCodeMonsterAgentWorkState");
    expect(petComponent).toContain("isTextEntryElement");
    expect(petComponent).toContain('setPlatformActivity("thinking")');
    expect(petComponent).toContain("isSleepyActivity");
    expect(petComponent).toContain("noWorkSleep");
    expect(petComponent).toContain("noWorkDoze");
    expect(petComponent).toContain('current.activityId === "dozing"');
    expect(petComponent).not.toContain("isMiniMode");
    expect(petComponent).not.toContain("data-mini=");
    expect(petComponent).toContain("resolveCloudCodeMonsterEyeOffset");
    // idle cursor-follow: gentle body lean/stretch toward the pointer
    expect(petComponent).toContain("resolveCloudCodeMonsterCursorPose");
    expect(petComponent).toContain("--monster-cursor-lean");
    expect(petComponent).toContain("--monster-cursor-stretch-x");
    expect(petComponent).toContain("deepSleeping={deepSleeping}");
    expect(petComponent).toContain("spriteActivityId");
    expect(petComponent).toContain("activityId={spriteActivityId}");
    expect(petComponent).not.toContain("resolveCloudCodeMonsterMotionPose");
    expect(petComponent).not.toContain("--monster-motion-");
    expect(petComponent).toContain("const isWalkingBasic = isDragging || isAutoWalking");
    // sprite renderer: textures + keyframe rows replace the legacy inline SVG
    expect(petComponent).toContain("MonsterSprite");
    expect(petComponent).toContain("walking={isWalking}");
    expect(petComponent).not.toContain("MonsterSvg");
    expect(petPixelParts).toContain("resolvePetSpriteRowId");
    expect(petPixelParts).toContain("petSpriteBodyUrl");
    expect(petPixelParts).toContain("petSpriteEyesUrl");
    expect(petPixelParts).toContain("--monster-sprite-row-y");
    expect(petPixelParts).toContain("--monster-sprite-cycle-ms");
    expect(petPixelParts).toContain("--monster-eye-x");
    expect(petPixelParts).toContain("resolveCloudCodeMonsterPreviewEyeOffset");
    expect(petPixelParts).toContain("eyeOffset?: PetPoint");
    expect(petPixelParts).toContain("eyeOffset={eyeOffset}");
    expect(petPixelParts).toContain("data-frames={row.frames}");
    expect(petPixelParts).toContain('row.eyes === "overlay"');
    expect(petPixelParts).not.toContain("<svg");
    expect(petPixelParts).not.toContain("<rect");
    expect(petSpriteManifest).toContain("Generated by scripts/generate-pet-sprites.mjs");
    expect(petSpriteManifest).toContain('"id": "walk"');
    expect(petSpriteManifest).toContain('"id": "sleep"');
    expect(petSpriteManifest).toContain('"id": "sleepDeep"');
    expect(petSpriteManifest).toContain('"id": "code"');
    expect(petCssModule).toContain("--monster-cursor-lean");
    expect(petCssModule).toContain("--monster-cursor-stretch-y");
    expect(petCssModule).not.toContain("--monster-motion-");
    expect(petCssModule).not.toContain("cloud-code-monster-breathe");
    expect(petCssModule).not.toContain("skewX");
    expect(petCssModule).toContain("image-rendering: pixelated");
    expect(petCssModule).toContain("@keyframes cloud-code-monster-sheet-2");
    expect(petCssModule).toContain("@keyframes cloud-code-monster-sheet-4");
    expect(petCssModule).toContain("steps(2, end)");
    expect(petCssModule).toContain("steps(4, end)");
    expect(petCssModule).toContain("@keyframes cloud-code-monster-eye-blink");
    expect(petCssModule).toContain("background-position-x: 66.6667%");
    expect(petCssModule).toContain("cloud-code-monster-fall-asleep 1.5s");
    expect(petCssModule).toContain("cloud-code-monster-wake 1.5s");
    expect(petCssModule).toContain("@keyframes cloud-code-monster-fall-asleep");
    expect(petCssModule).not.toContain("cloud-code-monster-doze 3.2s ease-in-out infinite");
    expect(petCssModule).toContain("var(--monster-walk-lift, -2px)");
    expect(petComponent).not.toContain("setDragPose");
    expect(petComponent).not.toContain("--monster-drag-");
    expect(petCssModule).not.toContain("--monster-drag-");
    expect(petCssModule).not.toContain("cloud-code-monster-drag-walk");
    expect(petCssModule).not.toContain("cloud-code-monster-mini-peek");
    expect(petCssModule).not.toContain('data-mini="true"');
    expect(petCssModule).not.toContain('.pet[data-dragging="true"] :global(.cloud-code-monster-pet-character)');
    expect(petCssModule).not.toContain('.pet[data-dragging="true"] :global(.cloud-code-monster-pet-left-foot)');
    expect(petPixelParts).toContain("withShadow");
    expect(petComponent).not.toContain("activityTriggerMode");
    expect(petDragHook).toContain("export function usePetDrag");
    expect(petDragHook).toContain("const handlePointerMove = useCallback");
    expect(petDragHook).toContain("if (isSleepyActivity(activityState?.activityId ?? null))");
    expect(petDragHook).toContain("wakeMonsterToDefault();");
    expect(petDragHook).not.toContain("DragMotionPose");
    expect(petDragHook).not.toContain("setDragPose");
    expect(petComponent).not.toContain("peekTargets = []");
    expect(petComponent).not.toContain("TimerRef = useRef");
    // Walk-to-target hook exists and has correct exports
    expect(petWalkTarget).toContain("export function useWalkToTarget");
    expect(petWalkTarget).toContain("createWalkToTargetVelocity");
    expect(petWalkTarget).toContain('data-pet-target-id');
    // Inbox button has pet target attribute
    expect(inboxPopover).toContain('data-pet-target-id="inbox"');
    // Landing page renders pet for logged-in users
    expect(landingPage).toContain("CloudCodeMonsterPet");
    expect(landingPage).toContain("isLoggedIn && petSettings.enabled");
    // Context hooks are safe outside providers
    expect(inboxCountContext).toContain("FALLBACK_INBOX_COUNT");
    expect(agentContext).toContain("useAgentContextSafe");
    for (const sensitiveShapeId of sensitiveShapeIds) {
      expect(clientPetSources).not.toContain(`"${sensitiveShapeId}"`);
    }
    expect(petPixelParts).toContain(
      'from "./cloud-code-monster-pet-sprite-manifest"'
    );
    expect(agentNode).toContain("data-agent-node-id={agent.id}");
    expect(agentNode).toContain('data-agent-working={activeTaskCount > 0 ? "true" : "false"}');
    expect(petCssModule).toContain(".pet {");
    expect(petCssModule).toContain(".button {");
    expect(petCssModule).toContain(".footprint {");
    expect(petCssModule).toContain("z-index: 51");
    expect(petCssModule).not.toContain(":global(.cloud-code-monster-pet)");
    expect(globalCss).not.toContain(".cloud-code-monster-pet");
    expect(globalCss).not.toContain(".home-pet");
    expect(globalCss).not.toContain(".pet-preview-flow");
  });
});

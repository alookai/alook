import staticContractInput0 from "./cloud-code-monster-pet.tsx?raw"
import staticContractInput2 from "./cloud-code-monster-pet-pixel-parts.tsx?raw"
import staticContractInput3 from "./cloud-code-monster-pet-types.ts?raw"
import staticContractInput4 from "./cloud-code-monster-pet-presets.ts?raw"
import staticContractInput5 from "./cloud-code-monster-pet-direct-shapes.tsx?raw"
import staticContractInput6 from "./cloud-code-monster-pet.module.css?raw"
import staticContractInput8 from "../home/home-page.tsx?raw"
import staticContractInput9 from "../../app/globals.css?raw"
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  calculateMonsterWalkIntensity,
  clampPetPosition,
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
  resolveCloudCodeMonsterAgentWorkState,
  resolveCloudCodeMonsterActivityState,
  resolveCloudCodeMonsterCursorPose,
  resolveCloudCodeMonsterEyeOffset,
  resolveCloudCodeMonsterMotionPose,
  resolveCloudCodeMonsterPeekPosition,
  resolveCloudCodeMonsterPreviewComebackState,
  resolveCloudCodeMonsterVisibleState,
  shouldCloudCodeMonsterAutoWalk,
  shouldFaintFromMonsterShake,
  shouldRefreshCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet";
import { usePetDrag } from "./cloud-code-monster-pet-drag";
import type { CloudCodeMonsterActivityId } from "./cloud-code-monster-pet-types";
import { readHomePetSettings } from "../../lib/home-pet-settings";

vi.mock("./cloud-code-monster-pet.module.css", () => ({
  default: { petLayer: "petLayer" },
}));


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

    expect(CLOUD_CODE_MONSTER_PET_PRESETS).toHaveLength(30);
    expect(presetIds.size).toBe(30);
    expect(publicNames).not.toEqual(expect.arrayContaining(sensitiveNames));
    expect(publicGroups).not.toContain("Licensed IP");
    expect(getCloudCodeMonsterPreset("pet-12").id).toBe("pet-12");
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

    expect(pointerHarness.stopTemporaryMotion).toHaveBeenCalledTimes(1);
    expect(pointerHarness.wakeMonsterToDefault).toHaveBeenCalledTimes(1);
    expect(pointerHarness.setIsDragging).not.toHaveBeenCalled();

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

  it("resolves cursor-following eyes and movement body pose", () => {
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

    const cursorPose = resolveCloudCodeMonsterCursorPose(
      { x: 300, y: 210 },
      { x: 100, y: 100 },
      { width: 82, height: 82 }
    );
    expect(cursorPose.eyeX).toBeGreaterThan(cursorPose.bodyX);
    expect(cursorPose.bodyX).toBeGreaterThan(0);
    expect(cursorPose.leanDeg).toBeGreaterThan(0);
    expect(cursorPose.shadowScaleX).toBeGreaterThan(1);

    expect(resolveCloudCodeMonsterMotionPose(false, "right", 2)).toEqual({
      leanDeg: 0,
      skewDeg: 0,
      stretchX: 1,
      stretchY: 1,
    });
    const fastRight = resolveCloudCodeMonsterMotionPose(true, "right", 2.4);
    const fastLeft = resolveCloudCodeMonsterMotionPose(true, "left", 2.4);

    expect(fastRight.leanDeg).toBeGreaterThan(0);
    expect(fastLeft.leanDeg).toBeLessThan(0);
    expect(fastRight.stretchX).toBeGreaterThan(1);
    expect(fastRight.stretchY).toBeLessThan(1);
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

describe("production landing PET mounting", () => {
  it("mounts only production PET surfaces", () => {
    const petComponent = staticContractInput0;
    const petPixelParts = staticContractInput2;
    const petTypes = staticContractInput3;
    const petPresets = staticContractInput4;
    const petDirectShapes = staticContractInput5;
    const petCssModule = staticContractInput6;
    const landingPage = staticContractInput8;
    const globalCss = staticContractInput9;
    const clientPetSources = [petTypes, petPresets, petDirectShapes].join("\n");
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

    expect(petComponent).not.toContain("useInboxCount");
    expect(landingPage).toContain("CloudCodeMonsterPet");
    expect(landingPage).toContain("isLoggedIn && petSettings.enabled");
    for (const sensitiveShapeId of sensitiveShapeIds) {
      expect(clientPetSources).not.toContain(`"${sensitiveShapeId}"`);
    }
    expect(petPixelParts).toContain(
      'import("./cloud-code-monster-pet-direct-shapes")'
    );
    expect(petCssModule).not.toContain(":global(.cloud-code-monster-pet)");
    expect(globalCss).not.toContain(".cloud-code-monster-pet");
    expect(globalCss).not.toContain(".home-pet");
    expect(globalCss).not.toContain(".pet-preview-flow");
  });
});

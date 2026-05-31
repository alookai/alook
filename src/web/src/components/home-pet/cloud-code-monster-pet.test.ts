import { readFileSync } from "node:fs";
import path from "node:path";
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

function webRoot() {
  return process.cwd().endsWith(`${path.sep}src${path.sep}web`)
    ? process.cwd()
    : path.join(process.cwd(), "src/web");
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
    const petDirectShapes = readFileSync(
      path.join(root, "src/components/home-pet/cloud-code-monster-pet-direct-shapes.tsx"),
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

    // Home page no longer renders pet directly
    expect(workspaceHomePage).not.toContain("CloudCodeMonsterPet");
    expect(workspaceHomePage).not.toContain("useHomePetSettings");
    expect(settingsPage).toContain('{ id: "pet", label: "Pet" }');
    expect(petTab).toContain("Enable pet");
    expect(petTab).not.toContain("Homepage only");
    expect(petTab).not.toContain("Global Display");
    expect(petTab).toContain("CloudCodeMonsterPresetPreview");
    expect(petTab).toContain("cloud-code-monster-pet-presets");
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
    expect(petComponent).toContain("useWalkToTarget");
    expect(petComponent).toContain("useAgentContextSafe");
    expect(petComponent).toContain("activeTaskDetails");
    expect(petComponent).toContain("hasRunningTasks");
    expect(petComponent).toContain("activeAgentTaskCountRef.current");
    expect(petComponent).toContain('clearPetTimer("attention")');
    expect(petComponent).toContain("resolveCloudCodeMonsterAgentWorkState");
    expect(petComponent).toContain("isTextEntryElement");
    expect(petComponent).toContain('setPlatformActivity("typing")');
    expect(petComponent).toContain("isSleepyActivity");
    expect(petComponent).toContain("noWorkSleep");
    expect(petComponent).toContain("noWorkDoze");
    expect(petComponent).toContain('current.activityId === "dozing"');
    expect(petComponent).not.toContain("isMiniMode");
    expect(petComponent).not.toContain("data-mini=");
    expect(petComponent).toContain("resolveCloudCodeMonsterEyeOffset");
    expect(petComponent).toContain("resolveCloudCodeMonsterCursorPose");
    expect(petComponent).toContain("resolveCloudCodeMonsterMotionPose");
    expect(petComponent).toContain("const isWalkingBasic = isDragging || isAutoWalking");
    expect(petPixelParts).toContain("eyeOffset");
    expect(petPixelParts).toContain("cloud-code-monster-pet-eyes-track");
    expect(petPixelParts).toContain('activityId === "coding" || activityId === "typing"');
    expect(petPixelParts).toContain('<rect x="32" y="22" width="64" height="12" fill={preset.bodyTop} />');
    expect(petPixelParts).toContain('<rect x="16" y="51" width="12" height="24" fill={preset.body} />');
    expect(petPixelParts).toContain('<rect x="100" y="51" width="12" height="24" fill={preset.body} />');
    expect(petPixelParts).toContain('x="44" y="42" width="11" height="12"');
    expect(petDirectShapes).toContain("eyeOffset");
    expect(petDirectShapes).toContain("eyeOffset={eyeOffset}");
    expect(petDirectShapes).toContain('case "dust-puff-shape"');
    expect(petDirectShapes).toContain('expression === "sleeping"');
    expect(petDirectShapes).toContain('<rect x="48" y="59" width="14" height="3" fill="#f5f2dc" />');
    expect(petDirectShapes).toContain('transform={`translate(${eyeOffset?.x ?? 0} ${eyeOffset?.y ?? 0})`}');
    expect(petCssModule).toContain("--monster-cursor-body-x");
    expect(petCssModule).toContain("cloud-code-monster-eye-blink");
    expect(petCssModule).toContain('.pet[data-activity="typing"] :global(.cloud-code-monster-pet-laptop)');
    expect(petCssModule).toContain("cloud-code-monster-fall-asleep 1.5s");
    expect(petCssModule).toContain("cloud-code-monster-wake 1.5s");
    expect(petCssModule).toContain('@keyframes cloud-code-monster-fall-asleep');
    expect(petCssModule).toContain('100% { transform: translateY(11px) rotate(-6deg) scale(1.12, 0.78); }');
    expect(petCssModule).toContain('50% { transform: translateY(12px) rotate(-6deg) scale(1.14, 0.76); }');
    expect(petCssModule).not.toContain('cloud-code-monster-doze 3.2s ease-in-out infinite');
    expect(petPixelParts).not.toContain("function MonsterHands");
    expect(petCssModule).not.toContain("cloud-code-monster-hand-type-left");
    expect(petCssModule).toContain("50% { transform: translateY(var(--monster-walk-lift, -2px)) rotate(2deg) scale(1.03, 0.97); }");
    expect(petComponent).not.toContain("setDragPose");
    expect(petComponent).not.toContain("--monster-drag-");
    expect(petCssModule).not.toContain("--monster-drag-");
    expect(petCssModule).not.toContain("cloud-code-monster-drag-walk");
    expect(petCssModule).not.toContain("cloud-code-monster-mini-peek");
    expect(petCssModule).not.toContain('data-mini="true"');
    expect(petCssModule).not.toContain('.pet[data-dragging="true"] :global(.cloud-code-monster-pet-character)');
    expect(petCssModule).not.toContain('.pet[data-dragging="true"] :global(.cloud-code-monster-pet-left-foot)');
    expect(petPixelParts).toContain("cloud-code-monster-pet-shadow-main");
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
      'import("./cloud-code-monster-pet-direct-shapes")'
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

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateMonsterWalkIntensity,
  CLOUD_CODE_MONSTER_ACTIVITIES,
  CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
  CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS,
  CLOUD_CODE_MONSTER_FAINT_EVENT_WINDOW_MS,
  CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS,
  CLOUD_CODE_MONSTER_FAINT_MS,
  CLOUD_CODE_MONSTER_PET_PRESETS,
  CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT,
  CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY,
  createCloudCodeMonsterWalkVelocity,
  createCloudCodeMonsterHiddenState,
  createCloudCodeMonsterIdleState,
  createCloudCodeMonsterPreviewAwayState,
  getCloudCodeMonsterExpression,
  getCloudCodeMonsterPreset,
  getMonsterFootstepIntervalMs,
  hasViolentMonsterDirectionChange,
  isMonsterFaintShakeEvent,
  isViolentMonsterDrag,
  pickCloudCodeMonsterActivity,
  reflectCloudCodeMonsterWalk,
  resolveCloudCodeMonsterPeekPosition,
  resolveCloudCodeMonsterPreviewComebackState,
  resolveCloudCodeMonsterActivityState,
  resolveCloudCodeMonsterVisibleState,
  shouldCloudCodeMonsterAutoWalk,
  shouldFaintFromMonsterShake,
  shouldRefreshCloudCodeMonsterActivity,
} from "./cloud-code-monster-pet";
import {
  clampPetPosition,
  getAmbientScenes,
  getPetPreset,
  getReactionScene,
  getReactionReturnScene,
  getSpriteFrameDelay,
  HOME_PET_SIZE,
  type PetPreset,
  selectAmbientScene,
  selectNextAmbientScene,
} from "./pet-presets";

function webRoot() {
  return process.cwd().endsWith(`${path.sep}src${path.sep}web`)
    ? process.cwd()
    : path.join(process.cwd(), "src/web");
}

describe("workspace home PET helpers", () => {
  const preset = getPetPreset("tater");

  it("keeps the PET small enough for the relationship canvas", () => {
    expect(HOME_PET_SIZE.width).toBeLessThanOrEqual(72);
    expect(HOME_PET_SIZE.height).toBeLessThanOrEqual(78);
  });

  it("selects only valid ambient preset scene names", () => {
    const ambientSceneNames = new Set(
      getAmbientScenes(preset).map((scene) => scene.name)
    );

    expect(ambientSceneNames.size).toBeGreaterThan(0);
    expect(selectAmbientScene(preset, 0).kind).toBe("ambient");
    expect(selectAmbientScene(preset, 0.42).kind).toBe("ambient");
    expect(selectAmbientScene(preset, 0.999).kind).toBe("ambient");
    expect(ambientSceneNames.has(selectAmbientScene(preset, 0.999).name)).toBe(
      true
    );
  });

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

  it("allows bounds taller than the first viewport", () => {
    expect(
      clampPetPosition(
        { x: 420, y: 1200 },
        { width: 500, height: 1600 },
        { width: 120, height: 140 },
        12
      )
    ).toEqual({ x: 368, y: 1200 });
  });

  it("keeps scene metadata ready for action-specific assets", () => {
    for (const scene of Object.values(preset.scenes)) {
      expect(scene.animationClass).toMatch(/^home-pet-motion-/);
      expect(scene.spriteAnimation.row).toBeGreaterThanOrEqual(0);
      expect(scene.spriteAnimation.frames).toBeGreaterThan(0);
      expect(scene.spriteAnimation.frameDurations.length).toBeGreaterThan(0);
      if (scene.kind === "ambient") {
        expect(scene.spriteAnimation.restDurationMs?.[0]).toBeGreaterThanOrEqual(3000);
      }
      expect(scene.asset?.src ?? preset.sprite.src).toBeTruthy();
      expect(scene.asset?.alt ?? preset.sprite.alt).toBeTruthy();
    }
  });

  it("adds a quiet rest after ambient sprite bursts but keeps reactions immediate", () => {
    const idle = preset.scenes.idle;
    const startled = preset.scenes.startled;

    expect(getSpriteFrameDelay(idle, 0, 0)).toBe(
      idle.spriteAnimation.restDurationMs?.[0]
    );
    expect(getSpriteFrameDelay(idle, 0, 1)).toBe(
      idle.spriteAnimation.restDurationMs?.[1]
    );
    expect(getSpriteFrameDelay(idle, 1, 0)).toBe(idle.spriteAnimation.frameDurations[1]);
    expect(
      getSpriteFrameDelay(startled, startled.spriteAnimation.frames - 1, 1)
    ).toBe(
      startled.spriteAnimation.frameDurations[startled.spriteAnimation.frames - 1]
    );
  });

  it("usually returns to idle between occasional ambient bursts", () => {
    expect(selectNextAmbientScene(preset, "thinking", 0.99).name).toBe("idle");
    expect(selectNextAmbientScene(preset, "idle", 0.2).name).toBe("idle");
    expect(selectNextAmbientScene(preset, "idle", 0.99).name).not.toBe("idle");
  });

  it("maps any ambient click reaction back to the previous normal scene", () => {
    const ambientScenes = getAmbientScenes(preset);

    for (const scene of ambientScenes) {
      expect(getReactionReturnScene(preset, scene.name)).toBe(scene);
    }

    expect(getReactionReturnScene(preset, "startled").name).toBe("idle");
  });

  it("does not require future presets to use the Tater scene names", () => {
    const customPreset: PetPreset = {
      id: "quiet",
      displayName: "Quiet",
      description: "A quiet PET preset.",
      sprite: {
        src: "/pets/quiet/spritesheet.webp",
        alt: "Quiet workspace PET",
      },
      homeScene: "rest",
      reactionScene: "blink",
      scenes: {
        rest: {
          name: "rest",
          label: "Rest",
          kind: "ambient",
          statusText: "resting",
          animationClass: "home-pet-motion-idle",
          spriteAnimation: {
            row: 0,
            frames: 1,
            frameDurations: [1000],
          },
        },
        blink: {
          name: "blink",
          label: "Blink",
          kind: "reaction",
          statusText: "blinked",
          animationClass: "home-pet-motion-startled",
          spriteAnimation: {
            row: 1,
            frames: 2,
            frameDurations: [120, 180],
          },
          returnTo: "rest",
        },
      },
    };

    expect(selectAmbientScene(customPreset, 0).name).toBe("rest");
    expect(getReactionScene(customPreset)?.name).toBe("blink");
    expect(getReactionReturnScene(customPreset, "blink").name).toBe("rest");
  });
});

describe("preview Claude Code monster PET activity state", () => {
  it("offers 30 unique configurable monster presets", () => {
    const presetIds = new Set(CLOUD_CODE_MONSTER_PET_PRESETS.map((preset) => preset.id));
    const colorPattern = /^#[0-9a-f]{6}$/i;
    const licensedIpTemplates = [
      { id: "pet-02", name: "Doraemon", feature: "bell", shape: "doraemon" },
      { id: "pet-03", name: "Pikachu", feature: "bolt", shape: "pikachu" },
      { id: "pet-04", name: "Kirby", feature: "star", shape: "kirby" },
      { id: "pet-05", name: "Bulbasaur", feature: "leaf", shape: "bulbasaur" },
      { id: "pet-06", name: "Charmander", feature: "flame", shape: "charmander" },
      { id: "pet-07", name: "Squirtle", feature: "fins", shape: "squirtle" },
      { id: "pet-08", name: "Minecraft Steve", feature: "visor", shape: "minecraft-steve" },
      { id: "pet-09", name: "Minecraft Creeper", feature: "mask", shape: "minecraft-creeper" },
      { id: "pet-10", name: "Minecraft Zombie", feature: "visor", shape: "minecraft-zombie" },
      { id: "pet-11", name: "Toad", feature: "mushroom", shape: "toad" },
      { id: "pet-12", name: "Sonic", feature: "spin", shape: "sonic" },
      { id: "pet-13", name: "Pac-Man", feature: "chomp", shape: "pacman" },
      { id: "pet-14", name: "Boo", feature: "ghost", shape: "boo" },
      { id: "pet-15", name: "Mario", feature: "cap", shape: "mario" },
      { id: "pet-16", name: "Winnie the Pooh", feature: "ears", shape: "pooh" },
      { id: "pet-17", name: "Hello Kitty", feature: "bow", shape: "hello-kitty" },
      { id: "pet-18", name: "My Melody", feature: "hood", shape: "my-melody" },
      { id: "pet-19", name: "Kuromi", feature: "mask", shape: "kuromi" },
      { id: "pet-20", name: "Totoro", feature: "ears", shape: "totoro" },
      { id: "pet-21", name: "Soot Sprite", feature: "soot", shape: "soot-sprite" },
      { id: "pet-22", name: "Luffy", feature: "straw", shape: "luffy" },
      { id: "pet-23", name: "Naruto", feature: "ninja", shape: "naruto" },
      { id: "pet-24", name: "Goku", feature: "pearl", shape: "goku" },
      { id: "pet-25", name: "Sailor Moon", feature: "wand", shape: "sailor-moon" },
      { id: "pet-26", name: "Gundam", feature: "mecha", shape: "gundam" },
      { id: "pet-27", name: "Dragon Quest Slime", feature: "slime", shape: "dragon-quest-slime" },
      { id: "pet-28", name: "Inkling", feature: "ink", shape: "inkling" },
      { id: "pet-29", name: "Snoopy", feature: "ears", shape: "snoopy" },
      { id: "pet-30", name: "Chopper", feature: "horns", shape: "chopper" },
    ];
    const licensedPresets = CLOUD_CODE_MONSTER_PET_PRESETS.slice(1);

    expect(CLOUD_CODE_MONSTER_PET_PRESETS).toHaveLength(30);
    expect(presetIds.size).toBe(30);
    expect(CLOUD_CODE_MONSTER_PET_PRESETS[0]).toMatchObject({
      id: "pet-01",
      name: "Claude Pixel",
      group: "Codex",
      body: "#d87352",
      feature: "square",
    });
    expect(
      licensedPresets.map(({ id, name, feature, shape }) => ({
        id,
        name,
        feature,
        shape,
      }))
    ).toEqual(licensedIpTemplates);
    expect(
      new Set(licensedPresets.map((preset) => preset.shape)).size
    ).toBe(29);
    expect(
      new Set(licensedPresets.map((preset) => preset.feature)).size
    ).toBeGreaterThanOrEqual(22);
    expect(
      licensedPresets.map((preset) => preset.shape)
    ).not.toEqual(
      licensedPresets.map(() => "monster")
    );
    expect(
      licensedPresets.some((preset) =>
        [
          "bot",
          "mouse",
          "round",
          "quad",
          "cat",
          "human",
          "mecha",
          "slime",
          "squid",
          "dog",
        ].includes(preset.shape ?? "")
      )
    ).toBe(false);
    expect(licensedPresets.map((preset) => preset.name)).toEqual(
      expect.arrayContaining([
        "Minecraft Steve",
        "Minecraft Creeper",
        "Minecraft Zombie",
      ])
    );

    for (const preset of CLOUD_CODE_MONSTER_PET_PRESETS) {
      if (preset.id !== "pet-01") {
        expect(preset.group).toBe("Licensed IP");
      }
      expect(preset.id).toMatch(/^pet-\d{2}$/);
      expect(preset.name.length).toBeGreaterThan(2);
      expect(preset.group.length).toBeGreaterThan(2);
      expect(preset.bodyTop).toMatch(colorPattern);
      expect(preset.body).toMatch(colorPattern);
      expect(preset.bodyDark).toMatch(colorPattern);
      expect(preset.bodyLight).toMatch(colorPattern);
      expect(preset.bodySideLight).toMatch(colorPattern);
      expect(preset.bodySideDark).toMatch(colorPattern);
      expect(preset.accent).toMatch(colorPattern);
      expect(preset.accessory).toMatch(colorPattern);
      expect(preset.eye).toMatch(colorPattern);
      expect(preset.highlight).toMatch(colorPattern);
    }
  });

  it("falls back to the default monster preset for invalid ids", () => {
    expect(getCloudCodeMonsterPreset("pet-12").id).toBe("pet-12");
    expect(getCloudCodeMonsterPreset("missing").id).toBe(
      CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id
    );
    expect(getCloudCodeMonsterPreset(null).id).toBe(
      CLOUD_CODE_MONSTER_PET_PRESETS[0]!.id
    );
  });

  it("keeps a monster activity stable until the 3 minute refresh window elapses", () => {
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
  });

  it("starts the monster in an activity when the page is first opened", () => {
    const initialState = resolveCloudCodeMonsterVisibleState(null, 5_000, 0.99);

    expect(CLOUD_CODE_MONSTER_ACTIVITIES.map((activity) => activity.id)).toContain(
      initialState.activityId
    );
    expect(initialState).toEqual({
      activityId: CLOUD_CODE_MONSTER_ACTIVITIES.at(-1)!.id,
      updatedAt: 5_000,
      hiddenAt: null,
    });
  });

  it("reuses the current monster state during frequent page switching", () => {
    const stored = {
      activityId: "coding" as const,
      updatedAt: 1_000,
      hiddenAt: 1_000,
    };

    expect(
      resolveCloudCodeMonsterVisibleState(
        stored,
        stored.hiddenAt + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS - 1,
        0.99
      )
    ).toEqual({
      activityId: "coding",
      updatedAt: 1_000,
      hiddenAt: null,
    });
  });

  it("picks a valid new monster activity after being away for the refresh window", () => {
    const now = 1_000 + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS;
    const next = resolveCloudCodeMonsterVisibleState(
      { activityId: null, updatedAt: 1_000, hiddenAt: 1_000 },
      now,
      0.99
    );

    expect(next.updatedAt).toBe(now);
    expect(next.hiddenAt).toBeNull();
    expect(CLOUD_CODE_MONSTER_ACTIVITIES.map((activity) => activity.id)).toContain(
      next.activityId
    );
  });

  it("does not refresh a stale idle state without an away marker", () => {
    const idleState = {
      activityId: null,
      updatedAt: 1_000,
      hiddenAt: null,
    };

    expect(
      resolveCloudCodeMonsterVisibleState(
        idleState,
        1_000 + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
        0.99
      )
    ).toEqual(idleState);
  });

  it("can interrupt an active monster activity back to the default state", () => {
    const active = resolveCloudCodeMonsterActivityState(
      { activityId: null, updatedAt: 1_000, hiddenAt: 1_000 },
      1_000 + CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
      0
    );

    expect(active.activityId).not.toBeNull();
    expect(createCloudCodeMonsterIdleState(8_000)).toEqual({
      activityId: null,
      updatedAt: 8_000,
      hiddenAt: null,
    });
  });

  it("records when the page is hidden before comeback activity selection", () => {
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
  });

  it("supports preview-only Other Page switching as a 3 minute away state", () => {
    const now = 20_000;
    const awayState = createCloudCodeMonsterPreviewAwayState(now);

    expect(awayState).toEqual({
      activityId: null,
      updatedAt: now - CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
      hiddenAt: now - CLOUD_CODE_MONSTER_ACTIVITY_REFRESH_MS,
    });
    expect(
      resolveCloudCodeMonsterVisibleState(awayState, now, 0.42).activityId
    ).not.toBeNull();
    expect(resolveCloudCodeMonsterPreviewComebackState(now, 0.42)).toEqual(
      resolveCloudCodeMonsterVisibleState(awayState, now, 0.42)
    );
  });

  it("selects deterministic monster activity boundaries", () => {
    expect(pickCloudCodeMonsterActivity(0).id).toBe(
      CLOUD_CODE_MONSTER_ACTIVITIES[0]!.id
    );
    expect(pickCloudCodeMonsterActivity(0.999).id).toBe(
      CLOUD_CODE_MONSTER_ACTIVITIES[
        CLOUD_CODE_MONSTER_ACTIVITIES.length - 1
      ]!.id
    );
  });

  it("keeps all random activities but only lets reading, phone, and snacking auto-walk", () => {
    expect(CLOUD_CODE_MONSTER_ACTIVITIES.map((activity) => activity.id)).toEqual(
      ["coding", "sleeping", "reading", "phone", "thinking", "snacking"]
    );
    expect(CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS).toEqual([
      "reading",
      "phone",
      "snacking",
    ]);
    expect(
      CLOUD_CODE_MONSTER_ACTIVITIES.filter((activity) =>
        shouldCloudCodeMonsterAutoWalk(activity.id)
      ).map((activity) => activity.id)
    ).toEqual(
      CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS
    );
    expect(shouldCloudCodeMonsterAutoWalk("coding")).toBe(false);
    expect(shouldCloudCodeMonsterAutoWalk("sleeping")).toBe(false);
    expect(shouldCloudCodeMonsterAutoWalk("thinking")).toBe(false);
    expect(shouldCloudCodeMonsterAutoWalk(null)).toBe(false);
  });

  it("increases walking intensity and footstep cadence as drag speed rises", () => {
    const slowWalk = calculateMonsterWalkIntensity(4, 40);
    const fastWalk = calculateMonsterWalkIntensity(70, 16);

    expect(fastWalk).toBeGreaterThan(slowWalk);
    expect(getMonsterFootstepIntervalMs(fastWalk)).toBeLessThan(
      getMonsterFootstepIntervalMs(slowWalk)
    );
  });

  it("creates real autonomous walk velocity and reflects from canvas bounds", () => {
    expect(createCloudCodeMonsterWalkVelocity(0, 3)).toEqual({
      x: 3,
      y: 0,
    });
    expect(createCloudCodeMonsterWalkVelocity(0.25, 3).x).toBeCloseTo(0, 6);
    expect(createCloudCodeMonsterWalkVelocity(0.25, 3).y).toBeCloseTo(3, 6);

    const rightBounce = reflectCloudCodeMonsterWalk(
      { x: 202, y: 40 },
      { x: 4, y: 1 },
      { width: 300, height: 240 },
      { width: 82, height: 82 },
      16
    );
    const topBounce = reflectCloudCodeMonsterWalk(
      { x: 44, y: 17 },
      { x: -2, y: -5 },
      { width: 300, height: 240 },
      { width: 82, height: 82 },
      16
    );

    expect(rightBounce.reflectedX).toBe(true);
    expect(rightBounce.velocity.x).toBeLessThan(0);
    expect(rightBounce.position.x).toBeLessThanOrEqual(202);
    expect(topBounce.reflectedY).toBe(true);
    expect(topBounce.velocity.y).toBeGreaterThan(0);
    expect(topBounce.position.y).toBeGreaterThanOrEqual(16);
  });

  it("keeps click shock distinct from violent shake and sleeping eyes", () => {
    expect(getCloudCodeMonsterExpression(null, false, false)).toBe("idle");
    expect(getCloudCodeMonsterExpression("sleeping", false, false)).toBe(
      "sleeping"
    );
    expect(getCloudCodeMonsterExpression("sleeping", true, false)).toBe(
      "shocked"
    );
    expect(getCloudCodeMonsterExpression(null, true, true)).toBe("shaken");
    expect(getCloudCodeMonsterExpression("phone", true, true, true)).toBe(
      "fainted"
    );
  });

  it("only treats fast drag or sharp fast reversal as a violent shake", () => {
    expect(isViolentMonsterDrag(10, 40)).toBe(false);
    expect(isViolentMonsterDrag(28, 120)).toBe(false);
    expect(isViolentMonsterDrag(28, 70, true)).toBe(false);
    expect(isViolentMonsterDrag(48, 50)).toBe(false);
    expect(isViolentMonsterDrag(58, 35)).toBe(true);
    expect(isViolentMonsterDrag(36, 20, true)).toBe(true);
  });

  it("detects sharp back-and-forth shake direction changes", () => {
    expect(
      hasViolentMonsterDirectionChange({ x: 30, y: 1 }, { x: -28, y: 0 })
    ).toBe(true);
    expect(
      hasViolentMonsterDirectionChange({ x: 30, y: 1 }, { x: 24, y: 2 })
    ).toBe(false);
    expect(
      hasViolentMonsterDirectionChange({ x: 12, y: 0 }, { x: -28, y: 0 })
    ).toBe(false);
  });

  it("requires sustained severe dragging before the monster faints", () => {
    expect(CLOUD_CODE_MONSTER_FAINT_MS).toBe(10_000);
    expect(isMonsterFaintShakeEvent(62, 42, true)).toBe(false);
    expect(isMonsterFaintShakeEvent(78, 52, false)).toBe(false);
    expect(isMonsterFaintShakeEvent(118, 38, false)).toBe(true);
    expect(isMonsterFaintShakeEvent(112, 40, true)).toBe(true);

    const sparseEvents = [0, CLOUD_CODE_MONSTER_FAINT_EVENT_WINDOW_MS + 1];
    const sustainedEvents = Array.from(
      { length: CLOUD_CODE_MONSTER_FAINT_MIN_EVENTS },
      (_, index) => index * 100
    );

    expect(shouldFaintFromMonsterShake(sparseEvents, 1_500)).toBe(false);
    expect(shouldFaintFromMonsterShake(sustainedEvents, 300)).toBe(false);
    expect(shouldFaintFromMonsterShake(sustainedEvents, 600)).toBe(true);
  });

  it("uses shape-specific pixel face expression configuration", () => {
    const monsterPet = readFileSync(
      path.join(webRoot(), "src/components/home-pet/cloud-code-monster-pet.tsx"),
      "utf8"
    );

    expect(monsterPet).toContain("singleEye");
    expect(monsterPet).toContain('mouthStyle?: "flat" | "open" | "smile" | "none"');
    expect(monsterPet).toContain('case "pacman"');
    expect(monsterPet).toContain("leftX={58} rightX={58} y={43} singleEye");
    expect(monsterPet).toContain('case "snoopy"');
    expect(monsterPet).toContain("leftX={61} rightX={61} y={43}");
    expect(monsterPet).toContain('case "my-melody"');
    expect(monsterPet).toContain('shape === "kuromi"');
    expect(monsterPet).toContain('mouthStyle="smile"');
    expect(monsterPet).toContain('highlightColor="#fff5ee"');
    expect(monsterPet).toContain('mouthColor="#7a3c55"');
    expect(monsterPet).toContain('leftX={50} rightX={70} y={44} color="#edf6ff"');
    expect(monsterPet).toContain('case "hello-kitty"');
    expect(monsterPet).toContain('color="#25201f" highlightColor="#fffdfa"');
    expect(monsterPet).toContain('mouthColor="#7b4542" mouthStyle="smile"');
  });
});

describe("workspace PET mounting", () => {
  it("does not mount the PET on the public landing page", () => {
    const landingPage = readFileSync(
      path.join(webRoot(), "src/app/page.tsx"),
      "utf8"
    );

    expect(landingPage).not.toContain("HomepagePet");
    expect(landingPage).not.toContain("home-pet");
  });

  it("mounts the PET inside the authenticated workspace home canvas", () => {
    const workspaceHomePage = readFileSync(
      path.join(webRoot(), "src/app/(app)/w/[slug]/home/page.tsx"),
      "utf8"
    );

    expect(workspaceHomePage).toContain(
      'import { CloudCodeMonsterPet } from "@/components/home-pet/cloud-code-monster-pet"'
    );
    expect(workspaceHomePage).toContain("activityTriggerMode={");
    expect(workspaceHomePage).toContain('petSettings.displayScope === "global" ? "global" : "home"');
    expect(workspaceHomePage).toContain("useHomePetSettings");
    expect(workspaceHomePage.indexOf("function AgentCanvas")).toBeLessThan(
      workspaceHomePage.indexOf("<CloudCodeMonsterPet")
    );
  });

  it("moves PET controls into workspace settings", () => {
    const settingsPage = readFileSync(
      path.join(webRoot(), "src/app/(app)/w/[slug]/settings/page.tsx"),
      "utf8"
    );
    const petTab = readFileSync(
      path.join(webRoot(), "src/app/(app)/w/[slug]/settings/pet-tab.tsx"),
      "utf8"
    );

    expect(settingsPage).toContain('{ id: "pet", label: "Pet" }');
    expect(settingsPage).toContain('import { PetTab } from "./pet-tab"');
    expect(settingsPage).toContain('activeTab === "pet" && <PetTab />');
    expect(petTab).toContain("Enable pet");
    expect(petTab).toContain("Homepage only");
    expect(petTab).toContain("Global Display");
    expect(petTab).toContain("CloudCodeMonsterPresetPreview");
    expect(petTab).toContain("writeCloudCodeMonsterPetPresetId");
    expect(petTab).not.toContain("selectedPreset.group");
    expect(petTab).not.toContain("preset.group");
  });

  it("mounts the global PET layer only for global non-home workspace pages", () => {
    const workspaceShell = readFileSync(
      path.join(webRoot(), "src/components/workspace-shell.tsx"),
      "utf8"
    );
    const workspacePetLayer = readFileSync(
      path.join(webRoot(), "src/components/home-pet/workspace-pet-layer.tsx"),
      "utf8"
    );

    expect(workspaceShell).toContain("WorkspacePetLayer");
    expect(workspaceShell).toContain("boundaryRef={shellRef}");
    expect(workspacePetLayer).toContain('petSettings.displayScope !== "global"');
    expect(workspacePetLayer).toContain('activityTriggerMode="global"');
    expect(workspacePetLayer).toContain("isHome");
    expect(workspacePetLayer).toContain("<CloudCodeMonsterPet");
  });

  it("exposes a public PET preview page without the authenticated app shell", () => {
    const previewRoute = readFileSync(
      path.join(webRoot(), "src/app/pet-preview/page.tsx"),
      "utf8"
    );
    const previewPage = readFileSync(
      path.join(webRoot(), "src/components/home-pet/pet-preview-page.tsx"),
      "utf8"
    );
    const monsterPet = readFileSync(
      path.join(webRoot(), "src/components/home-pet/cloud-code-monster-pet.tsx"),
      "utf8"
    );
    const globalCss = readFileSync(
      path.join(webRoot(), "src/app/globals.css"),
      "utf8"
    );
    const agentNode = readFileSync(
      path.join(webRoot(), "src/components/canvas/agent-node.tsx"),
      "utf8"
    );

    expect(previewRoute).toContain("PetPreviewPage");
    expect(previewPage).toContain("Home Page");
    expect(previewPage).toContain("Other Page");
    expect(previewPage).toContain("previewPetInitialPosition");
    expect(previewPage).toContain("CloudCodeMonsterPet");
    expect(previewPage).toContain("CloudCodeMonsterPresetPreview");
    expect(previewPage).toContain("CLOUD_CODE_MONSTER_PET_PRESETS");
    expect(previewPage).toContain("writeCloudCodeMonsterPetPresetId");
    expect(previewPage).toContain("Preset Library");
    expect(previewPage).not.toContain("selectedPreset.group");
    expect(previewPage).not.toContain("preset.group");
    expect(previewPage).toContain("thin-scrollbar");
    expect(previewPage).toContain("previewComebackToken");
    expect(previewPage).toContain("inboxCount");
    expect(previewPage).toContain("handleInboxClick");
    expect(previewPage).toContain("Inbox");
    expect(previewPage).toContain("notificationToken={inboxNotificationToken}");
    expect(monsterPet).toContain("cloud-code-monster-pet-shock");
    expect(monsterPet).toContain("notificationToken?: number");
    expect(monsterPet).toContain("notificationActive");
    expect(monsterPet).toContain("cloud-code-monster-pet-notification-bell");
    expect(monsterPet).toContain("cloud-code-monster-pet-notification-bell-pixel");
    expect(monsterPet).toContain('shapeRendering="crispEdges"');
    expect(monsterPet).not.toContain('d="M6.5 10.5');
    expect(monsterPet).toContain("data-notifying={notificationActive}");
    expect(monsterPet).toContain(CLOUD_CODE_MONSTER_PRESET_STORAGE_KEY);
    expect(monsterPet).toContain(CLOUD_CODE_MONSTER_PRESET_CHANGED_EVENT);
    expect(monsterPet).toContain("CloudCodeMonsterPresetPreview");
    expect(monsterPet).toContain("getCloudCodeMonsterPreset");
    expect(monsterPet).toContain('activityTriggerMode = "global"');
    expect(monsterPet).toContain('activityTriggerMode === "home"');
    expect(monsterPet).toContain("MonsterDirectPixelCharacter");
    expect(monsterPet).toContain('case "doraemon"');
    expect(monsterPet).toContain('case "minecraft-steve"');
    expect(monsterPet).toContain('case "minecraft-creeper"');
    expect(monsterPet).toContain('case "minecraft-zombie"');
    expect(monsterPet).not.toContain("MonsterLicensedShapeBase");
    expect(monsterPet).not.toContain("MonsterLicensedShapeFeet");
    expect(monsterPet).toContain('feature === "bolt"');
    expect(monsterPet).toContain('feature === "mushroom"');
    expect(monsterPet).toContain("MonsterPresetBodyMarks");
    expect(monsterPet).toContain(
      'data-reaction={shaken ? "shake" : reacting ? "shock" : "none"}'
    );
    expect(monsterPet).toContain('expression === "shocked"');
    expect(monsterPet).toContain('expression === "shaken"');
    expect(monsterPet).toContain('expression === "fainted"');
    expect(monsterPet).toContain("data-shaken");
    expect(monsterPet).toContain("data-fainted");
    expect(monsterPet).toContain("data-peeking");
    expect(monsterPet).toContain("cloud-code-monster-pet-sleep-z");
    expect(monsterPet).not.toContain('<rect x="88" y="19" width="6" height="6"');
    expect(monsterPet).toContain("isViolentMonsterDrag");
    expect(monsterPet).toContain("hasViolentMonsterDirectionChange");
    expect(monsterPet).toContain("isMonsterFaintShakeEvent");
    expect(monsterPet).toContain("shouldFaintFromMonsterShake");
    expect(monsterPet).toContain("reflectCloudCodeMonsterWalk");
    expect(monsterPet).toContain("createCloudCodeMonsterWalkVelocity");
    expect(monsterPet).toContain("autoWalkVelocityRef");
    expect(monsterPet).toContain("wakeMonsterToDefault");
    expect(monsterPet).not.toContain("event.button !== 0 || fainted");
    expect(monsterPet).not.toContain("!isDragging || fainted");
    expect(previewPage).not.toContain("previewWorkingAgentPeekTargets");
    expect(previewPage).not.toContain("peekTargets=");
    expect(previewPage).not.toContain('agentId: "ag_mandy"');
    expect(previewPage).not.toContain('agentId: "ag_fenge"');
    expect(previewPage).toContain('className="pet-preview-flow"');
    expect(globalCss).toContain(".pet-preview-flow .react-flow__node");
    expect(globalCss).toContain("z-index: 30 !important");
    expect(globalCss).toContain('.cloud-code-monster-pet[data-peeking="true"]');
    expect(globalCss).toContain("z-index: 2;");
    expect(monsterPet).toContain("resolveCloudCodeMonsterPeekPosition");
    expect(monsterPet).toContain("[data-agent-node-id]");
    expect(monsterPet).not.toContain("cloud-code-monster-pet-peek-cover");
    expect(agentNode).toContain("data-agent-node-id={agent.id}");
    expect(agentNode).toContain(
      'data-agent-working={activeTaskCount > 0 ? "true" : "false"}'
    );
    expect(previewPage).not.toContain("<HomepagePet");
    expect(monsterPet).not.toContain("cloud-code-monster-pet-bubble");
    expect(previewPage).not.toContain("sign-in");
    expect(previewPage).not.toContain("WorkspaceShell");
  });

  it("resolves peeking coordinates from a real agent node before using fallback coordinates", () => {
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

    const resolved = resolveCloudCodeMonsterPeekPosition(
      { agentId: "ag_mandy", x: 1, y: 1 },
      boundary,
      { width: 1000, height: 720 }
    );

    expect(resolved.x).toBeCloseTo(309);
    expect(resolved.y).toBeCloseTo(305.24);
    expect(
      resolveCloudCodeMonsterPeekPosition(
        { agentId: "missing", x: 245, y: 345 },
        boundary,
        { width: 1000, height: 720 }
      )
    ).toEqual({ x: 204, y: 283 });
  });
});

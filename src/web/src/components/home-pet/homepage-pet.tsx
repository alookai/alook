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
import {
  getDefaultPetPosition,
  getPetPreset,
  getReactionScene,
  getReactionReturnScene,
  getSpriteFrameDelay,
  HOME_PET_ATLAS,
  HOME_PET_REACTION_MS,
  HOME_PET_SIZE,
  selectAmbientScene,
  selectNextAmbientScene,
  type PetBounds,
  type PetPoint,
  type PetScene,
} from "./pet-presets";
import { clampPetPosition } from "./pet-presets";

type HomepagePetProps = {
  boundaryRef: RefObject<HTMLElement | null>;
  presetId?: string;
  initialPosition?: PetPoint;
};

function getHomepageBounds(boundary: HTMLElement | null): PetBounds {
  const width = boundary?.clientWidth ?? window.innerWidth;
  const height = boundary?.clientHeight ?? window.innerHeight;

  return {
    width,
    height,
  };
}

function getPointerPointInBoundary(
  event: ReactPointerEvent<HTMLButtonElement>,
  boundary: HTMLElement | null
): PetPoint {
  const boundaryRect = boundary?.getBoundingClientRect();

  return {
    x: event.clientX - (boundaryRect?.left ?? 0),
    y: event.clientY - (boundaryRect?.top ?? 0),
  };
}

export function HomepagePet({ boundaryRef, presetId, initialPosition }: HomepagePetProps) {
  const preset = getPetPreset(presetId);
  const [{ scene, lastAmbientScene }, setSceneState] = useState<{
    scene: PetScene;
    lastAmbientScene: PetScene;
  }>(() => {
    const initialScene = preset.scenes[preset.homeScene];

    return {
      scene: initialScene,
      lastAmbientScene: initialScene,
    };
  });
  const [position, setPosition] = useState<PetPoint | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [spriteFrame, setSpriteFrame] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const dragOffsetRef = useRef<PetPoint>({ x: 0, y: 0 });
  const dragStartPointRef = useRef<PetPoint | null>(null);
  const didDragRef = useRef(false);
  const reactionTimerRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const sceneAsset = scene.asset ?? preset.sprite;
  const spriteStyle = useMemo(
    () =>
      ({
        "--home-pet-sprite-url": `url("${sceneAsset.src}")`,
        "--home-pet-bg-width": `${HOME_PET_ATLAS.columns * HOME_PET_SIZE.width}px`,
        "--home-pet-bg-height": `${HOME_PET_ATLAS.rows * HOME_PET_SIZE.height}px`,
        "--home-pet-bg-x": `${-spriteFrame * HOME_PET_SIZE.width}px`,
        "--home-pet-bg-y": `${-scene.spriteAnimation.row * HOME_PET_SIZE.height}px`,
      }) as CSSProperties,
    [scene.spriteAnimation.row, sceneAsset.src, spriteFrame]
  );

  useEffect(() => {
    const initialScene = selectAmbientScene(preset);

    setSceneState({
      scene: initialScene,
      lastAmbientScene: initialScene,
    });
  }, [preset]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateReducedMotion = () =>
      setPrefersReducedMotion(mediaQuery.matches);

    updateReducedMotion();
    mediaQuery.addEventListener("change", updateReducedMotion);

    return () => mediaQuery.removeEventListener("change", updateReducedMotion);
  }, []);

  useEffect(() => {
    const syncPosition = () => {
      const bounds = getHomepageBounds(boundaryRef.current);

      setPosition((currentPosition) =>
        currentPosition
          ? clampPetPosition(currentPosition, bounds)
          : clampPetPosition(initialPosition ?? getDefaultPetPosition(bounds), bounds)
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
    };
  }, []);

  useEffect(() => {
    setSpriteFrame(0);
  }, [scene.name]);

  useEffect(() => {
    if (prefersReducedMotion) {
      return;
    }

    const animation = scene.spriteAnimation;
    const isLastFrame = spriteFrame >= animation.frames - 1;

    if (scene.kind === "reaction" && isLastFrame) {
      return;
    }

    const duration = getSpriteFrameDelay(scene, spriteFrame);
    const timeout = window.setTimeout(() => {
      if (!isLastFrame) {
        setSpriteFrame(spriteFrame + 1);
        return;
      }

      setSpriteFrame(0);

      if (scene.kind === "ambient") {
        const nextScene = selectNextAmbientScene(preset, scene.name);
        setSceneState({
          scene: nextScene,
          lastAmbientScene: nextScene,
        });
      }
    }, duration);

    return () => window.clearTimeout(timeout);
  }, [preset, prefersReducedMotion, scene, spriteFrame]);

  const startReaction = () => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }

    if (isDragging) {
      return;
    }

    if (reactionTimerRef.current) {
      window.clearTimeout(reactionTimerRef.current);
    }

    const returnScene = getReactionReturnScene(preset, lastAmbientScene.name);
    const reactionScene = getReactionScene(preset);

    if (!reactionScene) {
      return;
    }

    setSceneState({
      scene: reactionScene,
      lastAmbientScene: returnScene,
    });

    reactionTimerRef.current = window.setTimeout(() => {
      setSceneState({
        scene: returnScene,
        lastAmbientScene: returnScene,
      });
      reactionTimerRef.current = null;
    }, HOME_PET_REACTION_MS);
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    if (event.button !== 0) {
      return;
    }

    const bounds = getHomepageBounds(boundaryRef.current);
    const currentPosition = position ?? getDefaultPetPosition(bounds);
    const pointerPoint = getPointerPointInBoundary(event, boundaryRef.current);

    dragOffsetRef.current = {
      x: pointerPoint.x - currentPosition.x,
      y: pointerPoint.y - currentPosition.y,
    };
    dragStartPointRef.current = pointerPoint;
    didDragRef.current = false;
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    if (!isDragging) {
      return;
    }

    const bounds = getHomepageBounds(boundaryRef.current);
    const pointerPoint = getPointerPointInBoundary(event, boundaryRef.current);
    const nextPosition = {
      x: pointerPoint.x - dragOffsetRef.current.x,
      y: pointerPoint.y - dragOffsetRef.current.y,
    };
    const dragStartPoint = dragStartPointRef.current ?? pointerPoint;
    const movementX = Math.abs(pointerPoint.x - dragStartPoint.x);
    const movementY = Math.abs(pointerPoint.y - dragStartPoint.y);

    if (movementX > 3 || movementY > 3) {
      didDragRef.current = true;
    }

    setPosition(
      clampPetPosition(nextPosition, bounds)
    );
  };

  const stopDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isDragging) {
      return;
    }

    setIsDragging(false);
    dragStartPointRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!position) {
    return null;
  }

  return (
    <aside
      aria-label={`${preset.displayName} workspace PET status`}
      className="home-pet"
      data-scene-kind={scene.kind}
      style={{
        "--home-pet-x": `${position.x}px`,
        "--home-pet-y": `${position.y}px`,
      } as CSSProperties}
    >
      <div className="home-pet-status" aria-live="polite">
        <span className="home-pet-status-kicker">{preset.displayName}</span>
        <span>{scene.statusText}</span>
      </div>
      <button
        type="button"
        className={`home-pet-button ${scene.animationClass}`}
        data-dragging={isDragging}
        onClick={startReaction}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onLostPointerCapture={stopDragging}
        aria-label={`${preset.displayName}: ${scene.statusText}. Click to greet, drag to move.`}
        style={{
          width: HOME_PET_SIZE.width,
          height: HOME_PET_SIZE.height,
        }}
      >
        <span
          aria-label={sceneAsset.alt}
          className="home-pet-sprite"
          role="img"
          style={spriteStyle}
        />
      </button>
    </aside>
  );
}

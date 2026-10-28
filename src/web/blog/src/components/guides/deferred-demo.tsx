"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { claimGuidePlayback, refreshGuidePlayback, registerGuidePlayback } from "./playback";
import styles from "./guide.module.css";

type Timeline = { play: () => unknown; pause: () => unknown; restart: () => unknown; kill: () => unknown; progress: (value: number) => unknown };
type SceneModule = { createScene: (root: HTMLElement, complete: () => void) => Timeline };
const loaders: Record<"connect" | "bots" | "server" | "message", () => Promise<SceneModule>> = {
  connect: () => import("./scenes/connect"),
  bots: () => import("./scenes/bots"),
  server: () => import("./scenes/server"),
  message: () => import("./scenes/message"),
};

export function DeferredDemo({ scene, label, children }: { scene: keyof typeof loaders; label: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const timeline = useRef<Timeline | null>(null);
  const visible = useRef(false);
  const manuallyPaused = useRef(false);
  const ended = useRef(false);
  const load = useRef<() => void>(() => {});
  const id = useId();
  const [status, setStatus] = useState<"static" | "loading" | "ready" | "playing" | "paused" | "ended" | "failed">("static");

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false;
    let loading = false;
    let generation = 0;
    const pause = () => {
      timeline.current?.pause();
      setStatus((value) => value === "playing" ? "paused" : value);
    };
    load.current = () => {
      if (disposed || !visible.current || motion.matches || loading || timeline.current) return;
      loading = true;
      const request = ++generation;
      setStatus("loading");
      void loaders[scene]().then((module) => {
        if (disposed || request !== generation || motion.matches) return;
        timeline.current = module.createScene(element, () => { ended.current = true; setStatus("ended"); });
        setStatus("ready");
        refreshGuidePlayback();
      }).catch(() => {
        if (!disposed && request === generation) setStatus("failed");
      }).finally(() => { loading = false; });
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting && entry.intersectionRatio >= 0.35;
      if (visible.current) load.current();
      else pause();
      refreshGuidePlayback();
    }, { rootMargin: "0px", threshold: 0.35 });
    observer.observe(element);
    const unregister = registerGuidePlayback(id, { element, pause, select: () => {
      visible.current = true;
      load.current();
      if (timeline.current && !manuallyPaused.current && !ended.current && !motion.matches) {
        timeline.current.play();
        setStatus("playing");
      }
    } });
    const onMotion = () => {
      if (motion.matches) {
        generation++;
        timeline.current?.progress(0);
        timeline.current?.kill();
        timeline.current = null;
        setStatus("static");
      } else load.current();
    };
    let width = element.clientWidth;
    const onResize = () => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      if (!timeline.current) return;
      timeline.current.progress(0);
      timeline.current.kill();
      timeline.current = null;
      ended.current = false;
      setStatus("static");
      load.current();
      refreshGuidePlayback();
    };
    window.addEventListener("resize", onResize);
    motion.addEventListener("change", onMotion);
    return () => {
      disposed = true;
      observer.disconnect();
      timeline.current?.kill();
      timeline.current = null;
      unregister();
      motion.removeEventListener("change", onMotion);
      window.removeEventListener("resize", onResize);
    };
  }, [id, scene]);

  function play(restart = false) {
    if (!timeline.current || !visible.current) return;
    manuallyPaused.current = false;
    ended.current = false;
    claimGuidePlayback(id);
    if (restart || status === "ended") timeline.current.restart();
    else timeline.current.play();
    setStatus("playing");
  }

  const enabled = ["ready", "playing", "paused", "ended"].includes(status);
  return (
    <figure className={styles.demo} aria-label={label} data-guide-demo={scene} data-demo-status={status}>
      <noscript><style>{`.${styles.stage}{height:auto!important}.${styles.stage} [data-demo-frame]{position:relative;inset:auto;visibility:visible;opacity:1}.${styles.demoCaption}{display:none}`}</style></noscript>
      <div ref={root} className={styles.stage} aria-hidden="true" inert>{children}</div>
      <div className={styles.demoCaption} role="group" aria-label={`${label} playback`}>
        <div className={styles.controls}>
          {status === "failed" ? <button onClick={() => load.current()}>Retry animation</button> :
            <button disabled={!enabled} aria-label={status === "playing" ? `Pause ${label}` : `Play ${label}`} onClick={() => {
              if (status === "playing") { manuallyPaused.current = true; timeline.current?.pause(); setStatus("paused"); }
              else play();
            }}>{status === "playing" ? <Pause size={14} /> : <Play size={14} />}<span>{status === "playing" ? "Pause" : "Play"}</span></button>}
          <button disabled={!enabled} aria-label={`Replay ${label}`} onClick={() => play(true)}><RotateCcw size={14} /><span>Replay</span></button>
        </div>
      </div>
    </figure>
  );
}

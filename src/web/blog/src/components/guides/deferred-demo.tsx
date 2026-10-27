"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import styles from "./guide.module.css";

type Timeline = { play: () => unknown; pause: () => unknown; restart: () => unknown; kill: () => unknown; progress: (value: number) => unknown };
type SceneModule = { createScene: (root: HTMLElement, complete: () => void) => Timeline };
const loaders: Record<"connect" | "bots", () => Promise<SceneModule>> = {
  connect: () => import("./scenes/connect"),
  bots: () => import("./scenes/bots"),
};

export function DeferredDemo({ scene, label, children }: { scene: keyof typeof loaders; label: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const timeline = useRef<Timeline | null>(null);
  const visible = useRef(false);
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
        timeline.current = module.createScene(element, () => setStatus("ended"));
        setStatus("ready");
      }).catch(() => {
        if (!disposed && request === generation) setStatus("failed");
      }).finally(() => { loading = false; });
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting;
      if (entry.isIntersecting) load.current();
      else pause();
    }, { rootMargin: "0px", threshold: 0 });
    observer.observe(element);
    const onVisibility = () => { if (document.hidden) pause(); };
    const onOtherPlay = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) pause(); };
    const onMotion = () => {
      if (motion.matches) {
        generation++;
        timeline.current?.progress(0);
        timeline.current?.kill();
        timeline.current = null;
        setStatus("static");
      } else load.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("alook-guide-play", onOtherPlay);
    motion.addEventListener("change", onMotion);
    return () => {
      disposed = true;
      observer.disconnect();
      timeline.current?.kill();
      timeline.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("alook-guide-play", onOtherPlay);
      motion.removeEventListener("change", onMotion);
    };
  }, [id, scene]);

  function play(restart = false) {
    if (!timeline.current || !visible.current) return;
    window.dispatchEvent(new CustomEvent("alook-guide-play", { detail: id }));
    if (restart || status === "ended") timeline.current.restart();
    else timeline.current.play();
    setStatus("playing");
  }

  const enabled = ["ready", "playing", "paused", "ended"].includes(status);
  return (
    <figure className={styles.demo} aria-label={label} data-guide-demo={scene} data-demo-status={status}>
      <div ref={root} className={styles.stage} aria-hidden="true">{children}</div>
      <figcaption className={styles.demoCaption}>
        <span>Illustrative demo · waiting time shortened</span>
        <div className={styles.controls}>
          {status === "failed" ? <button onClick={() => load.current()}>Retry animation</button> :
            <button disabled={!enabled} aria-label={status === "playing" ? `Pause ${label}` : `Play ${label}`} onClick={() => {
              if (status === "playing") { timeline.current?.pause(); setStatus("paused"); }
              else play();
            }}>{status === "playing" ? <Pause size={14} /> : <Play size={14} />}<span>{status === "playing" ? "Pause" : "Play"}</span></button>}
          <button disabled={!enabled} aria-label={`Replay ${label}`} onClick={() => play(true)}><RotateCcw size={14} /><span>Replay</span></button>
        </div>
      </figcaption>
    </figure>
  );
}

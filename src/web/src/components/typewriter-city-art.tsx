"use client";

import { useEffect, useRef, useState } from "react";
import { TYPEWRITER_CITY_ART } from "./typewriter-city-art-data";
import styles from "./typewriter-city-art.module.css";

export function TypewriterCityArt() {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;

    const draw = () => {
      const source = document.createElement("canvas");
      source.width = 3200;
      source.height = 1800;
      const context = source.getContext("2d");
      if (!context) return;
      context.font = '20px "Alook Jgs5"';
      context.fillStyle = getComputedStyle(frame).color;
      context.textBaseline = "top";
      TYPEWRITER_CITY_ART.split("\n").forEach((line, index) => {
        context.fillText(line, 0, index * 20);
      });
      const width = Math.max(1, Math.min(3200, Math.round(frame.clientWidth * window.devicePixelRatio)));
      let image = source;
      while (image.width / 2 > width) {
        const smaller = document.createElement("canvas");
        smaller.width = image.width / 2;
        smaller.height = image.height / 2;
        const smallerContext = smaller.getContext("2d");
        if (!smallerContext) return;
        smallerContext.drawImage(image, 0, 0, smaller.width, smaller.height);
        image = smaller;
      }
      canvas.width = width;
      canvas.height = Math.round(width * 9 / 16);
      const output = canvas.getContext("2d");
      if (!output) return;
      output.imageSmoothingQuality = "high";
      output.drawImage(image, 0, 0, canvas.width, canvas.height);
      setReady(true);
    };

    void document.fonts?.load('20px "Alook Jgs5"').then(() => {
      if (disposed) return;
      draw();
      observer = new ResizeObserver(draw);
      observer.observe(frame);
    }).catch(() => {});
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, []);

  return (
    <div ref={frameRef} className={styles.frame} role="img" aria-label="A giant Alook sculpture in an ASCII city, surrounded by buildings, a park, and streets.">
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <pre className={`${styles.art}${ready ? ` ${styles.rendered}` : ""}`} aria-hidden="true">{TYPEWRITER_CITY_ART}</pre>
    </div>
  );
}

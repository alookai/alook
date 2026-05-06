"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  type AvatarConfig,
  AvatarRenderer,
  Shapes,
  Eyes,
  Noses,
  BG_COLORS,
  SHAPE_KEYS,
  EYE_KEYS,
  NOSE_KEYS,
  PRESETS,
  randomConfig,
} from "./avatar-parts";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────
// CYCLER — left/right carousel for picking a part
// ─────────────────────────────────────────────────────────────
function Cycler<K extends string>({
  label,
  keys,
  value,
  onChange,
  renderThumb,
  mobile = false,
}: {
  label: string;
  keys: K[];
  value: K;
  onChange: (v: K) => void;
  renderThumb: (key: K) => React.ReactNode;
  mobile?: boolean;
}) {
  const idx = keys.indexOf(value);
  const go = (delta: number) =>
    onChange(keys[(idx + delta + keys.length) % keys.length]!);

  const prev = keys[(idx - 1 + keys.length) % keys.length]!;
  const next = keys[(idx + 1) % keys.length]!;

  return (
    <div className="flex items-center gap-2">
      <span className="w-12 text-xs font-medium text-muted-foreground shrink-0">
        {label}
      </span>
      <button
        type="button"
        onClick={() => go(-1)}
        className={cn(
          "flex items-center justify-center rounded-md hover:bg-accent transition-colors",
          mobile ? "size-10" : "size-7"
        )}
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path
            d="M15 5 L8 12 L15 19"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div className="flex items-center gap-1 flex-1 justify-center">
        <button
          type="button"
          onClick={() => go(-1)}
          className="opacity-30 hover:opacity-60 transition-opacity"
          tabIndex={-1}
        >
          {renderThumb(prev)}
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          className="border-2 border-primary rounded-lg p-0.5"
        >
          {renderThumb(value)}
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          className="opacity-30 hover:opacity-60 transition-opacity"
          tabIndex={-1}
        >
          {renderThumb(next)}
        </button>
      </div>
      <button
        type="button"
        onClick={() => go(1)}
        className={cn(
          "flex items-center justify-center rounded-md hover:bg-accent transition-colors",
          mobile ? "size-10" : "size-7"
        )}
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path
            d="M9 5 L16 12 L9 19"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// AVATAR GENERATOR
// ─────────────────────────────────────────────────────────────
interface AvatarGeneratorProps {
  config: AvatarConfig;
  onChange: (config: AvatarConfig) => void;
  /** "horizontal" puts preview left + controls right; default is vertical stack */
  layout?: "vertical" | "horizontal";
  /** Mobile mode — smaller preview, bigger touch targets, 3-col grid */
  mobile?: boolean;
}

export function AvatarGenerator({ config, onChange, layout = "vertical", mobile = false }: AvatarGeneratorProps) {
  const [tab, setTab] = useState<"presets" | "custom">("presets");

  const setField = useCallback(
    <K extends keyof AvatarConfig>(key: K, value: AvatarConfig[K]) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange]
  );

  // Shake animation on config change
  const [shaking, setShaking] = useState(false);
  const prevConfigRef = useRef(config);
  useEffect(() => {
    if (
      prevConfigRef.current.shape !== config.shape ||
      prevConfigRef.current.eye !== config.eye ||
      prevConfigRef.current.nose !== config.nose ||
      prevConfigRef.current.bg !== config.bg
    ) {
      setShaking(true);
      const timer = setTimeout(() => setShaking(false), 450);
      prevConfigRef.current = config;
      return () => clearTimeout(timer);
    }
  }, [config]);


  // Spacebar shortcut for random in horizontal (dialog) mode
  useEffect(() => {
    if (layout !== "horizontal") return;
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        onChange(randomConfig());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [layout, onChange]);

  const renderShapeThumb = (key: string) => (
    <svg viewBox="0 0 200 200" width="40" height="40" className="dark:invert">
      {Shapes[key]?.render()}
    </svg>
  );
  const renderNoseThumb = (key: string) => (
    <svg viewBox="-14 -10 28 20" width="36" height="24" className="dark:invert">
      {Noses[key]?.render()}
    </svg>
  );
  const renderEyeThumb = (key: string) => (
    <svg viewBox="-18 -8 36 16" width="44" height="22" className="dark:invert">
      {Eyes[key]?.render(8)}
    </svg>
  );

  const isHorizontal = layout === "horizontal";

  const previewSize = isHorizontal ? 220 : mobile ? 120 : 160;

  const preview = (
    <div className={cn(
      "flex flex-col items-center gap-3 rounded-2xl bg-muted/30",
      mobile ? "p-3" : "p-4",
      isHorizontal ? "w-70 shrink-0 justify-center" : ""
    )}>
      <div className={cn("rounded-2xl", shaking && "animate-[shake_0.45s_cubic-bezier(.36,.07,.19,.97)]")}>
        <AvatarRenderer config={config} size={previewSize} />
      </div>
      <button
        type="button"
        onClick={() => onChange(randomConfig())}
        className="inline-flex items-center gap-2 rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:bg-foreground/80 transition-colors"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="20" height="20" rx="3" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" />
          <circle cx="16" cy="8" r="1.5" fill="currentColor" />
          <circle cx="8" cy="16" r="1.5" fill="currentColor" />
          <circle cx="16" cy="16" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
        </svg>
        Random
        {isHorizontal && (
          <kbd className="ml-1 rounded bg-background/20 px-1.5 py-0.5 text-[10px] font-mono">Space</kbd>
        )}
      </button>
    </div>
  );

  const controls = (
    <div className={cn(
      "flex flex-col gap-3 flex-1 min-w-0",
      isHorizontal && "rounded-2xl bg-muted/30 p-4 h-95"
    )}>
      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          type="button"
          onClick={() => setTab("presets")}
          className={cn(
            "flex-1 pb-2 text-sm font-medium text-center transition-colors border-b-2",
            tab === "presets"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          ★ Presets
        </button>
        <button
          type="button"
          onClick={() => setTab("custom")}
          className={cn(
            "flex-1 pb-2 text-sm font-medium text-center transition-colors border-b-2",
            tab === "custom"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          ⚙ Custom
        </button>
      </div>

      {/* Tab content — fixed height so dialog doesn't resize on tab switch */}
      <div className={cn("flex-1 min-h-0", isHorizontal && "overflow-y-auto thin-scrollbar")}>
      {tab === "presets" && (
        <div className={cn("grid gap-2", mobile ? "grid-cols-3" : "grid-cols-4")}>
          {PRESETS.map((p) => {
            const isActive =
              p.config.shape === config.shape &&
              p.config.eye === config.eye &&
              p.config.nose === config.nose &&
              p.config.bg === config.bg;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => onChange(p.config)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl border p-2 transition-all",
                  isActive
                    ? "border-primary border-2 bg-primary/5 shadow-sm"
                    : "border-border bg-background hover:border-primary/40"
                )}
              >
                <AvatarRenderer config={p.config} size={56} />
                <span className="text-[10px] text-muted-foreground">
                  {p.name}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {tab === "custom" && (
        <div className="flex flex-col gap-4">
          <Cycler
            label="Shape"
            keys={SHAPE_KEYS}
            value={config.shape}
            onChange={(v) => setField("shape", v)}
            renderThumb={renderShapeThumb}
            mobile={mobile}
          />
          <Cycler
            label="Nose"
            keys={NOSE_KEYS}
            value={config.nose}
            onChange={(v) => setField("nose", v)}
            renderThumb={renderNoseThumb}
            mobile={mobile}
          />
          <Cycler
            label="Eyes"
            keys={EYE_KEYS}
            value={config.eye}
            onChange={(v) => setField("eye", v)}
            renderThumb={renderEyeThumb}
            mobile={mobile}
          />

          {/* Background colors */}
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              Color
            </div>
            <div className={cn("flex flex-wrap p-1", mobile ? "gap-3" : "gap-2")}>
              {BG_COLORS.map((c, i) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setField("bg", i)}
                  title={c.name}
                  className={cn(
                    "rounded-full transition-shadow",
                    mobile ? "size-8" : "size-7",
                    config.bg === i
                      ? "ring-2 ring-primary ring-offset-2"
                      : "ring-1 ring-border"
                  )}
                  style={{ backgroundColor: c.value }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );

  if (isHorizontal) {
    return (
      <div className="flex gap-4">
        {preview}
        {controls}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {preview}
      {controls}
    </div>
  );
}

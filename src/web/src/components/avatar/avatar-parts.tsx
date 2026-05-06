// Avatar parts library — inline SVG components for modular avatar generation.
// Ported from Jacky's Notion-style avatar generator prototype.
// All shapes are pure SVG paths — no external PNG files needed.

import type { ReactNode } from "react";

// ─────────────────────────────────────────────────────────────
// STROKE / FILL CONSTANTS
// ─────────────────────────────────────────────────────────────
const STROKE = "#1F1F1F";
const FILL = "#FFFFFF";
const SW_OUT = 8;
const SW_INNER = 5;
const SW_FACE = 5;

const sp = (w = SW_OUT) =>
  ({ fill: FILL, stroke: STROKE, strokeWidth: w, strokeLinejoin: "round" as const, strokeLinecap: "round" as const });
const lp = (w = SW_INNER) =>
  ({ fill: "none", stroke: STROKE, strokeWidth: w, strokeLinejoin: "round" as const, strokeLinecap: "round" as const });
const lpf = (w = SW_FACE) =>
  ({ fill: "none", stroke: STROKE, strokeWidth: w, strokeLinejoin: "round" as const, strokeLinecap: "round" as const });
const fp = { fill: STROKE };

// ─────────────────────────────────────────────────────────────
// PALETTES
// ─────────────────────────────────────────────────────────────
export interface ColorOption {
  name: string;
  value: string;
}

export const BG_COLORS: ColorOption[] = [
  { name: "Purple", value: "#9B7FE8" },
  { name: "Teal", value: "#2BAA9C" },
  { name: "Orange", value: "#F39A4F" },
  { name: "Blue", value: "#3D7EE8" },
  { name: "Pink", value: "#F8B4C4" },
  { name: "Yellow", value: "#F4C141" },
  { name: "Green", value: "#7FCB6F" },
  { name: "Beige", value: "#D6CCB8" },
  { name: "Red", value: "#EE5E48" },
  { name: "Lake Blue", value: "#3FA8C0" },
  { name: "Gray", value: "#C9D1D9" },
  { name: "Deep Purple", value: "#6A4DCC" },
];

// ─────────────────────────────────────────────────────────────
// SHAPES (outlines)
// ─────────────────────────────────────────────────────────────
export interface ShapeDef {
  name: string;
  face: { cx: number; cy: number; w: number };
  render: () => ReactNode;
}

export const Shapes: Record<string, ShapeDef> = {
  circle: {
    name: "Circle",
    face: { cx: 100, cy: 105, w: 80 },
    render: () => <circle cx="100" cy="100" r="70" {...sp()} />,
  },
  rounded: {
    name: "Rounded",
    face: { cx: 100, cy: 105, w: 90 },
    render: () => <rect x="30" y="30" width="140" height="140" rx="20" {...sp()} />,
  },
  hexagon: {
    name: "Hexagon",
    face: { cx: 100, cy: 105, w: 86 },
    render: () => <path d="M100 28 L162 64 L162 136 L100 172 L38 136 L38 64 Z" {...sp()} />,
  },
  task: {
    name: "Task",
    face: { cx: 92, cy: 92, w: 70 },
    render: () => (
      <g>
        <rect x="34" y="34" width="132" height="132" rx="14" {...sp()} />
        <path d="M70 110 L102 138 L168 64" {...lp(SW_OUT)} />
      </g>
    ),
  },
  book: {
    name: "Book",
    face: { cx: 100, cy: 105, w: 90 },
    render: () => (
      <g>
        <path d="M30 60 C 60 50, 85 56, 100 70 C 115 56, 140 50, 170 60 L 170 158 C 140 148, 115 154, 100 168 C 85 154, 60 148, 30 158 Z" {...sp()} />
        <path d="M100 70 L100 84" {...lp(SW_INNER)} />
        <path d="M100 154 L100 168" {...lp(SW_INNER)} />
      </g>
    ),
  },
  mail: {
    name: "Mail",
    face: { cx: 100, cy: 118, w: 80 },
    render: () => (
      <g>
        <rect x="30" y="56" width="140" height="100" rx="12" {...sp()} />
        <path d="M36 64 L100 108 L164 64" {...lp(SW_INNER)} />
      </g>
    ),
  },
  calendar: {
    name: "Calendar",
    face: { cx: 100, cy: 122, w: 80 },
    render: () => (
      <g>
        <rect x="30" y="48" width="140" height="124" rx="12" {...sp()} />
        <path d="M30 80 L170 80" {...lp(SW_INNER)} />
        <path d="M62 36 L62 60" {...lp(SW_INNER)} />
        <path d="M138 36 L138 60" {...lp(SW_INNER)} />
      </g>
    ),
  },
  bulb: {
    name: "Bulb",
    face: { cx: 100, cy: 100, w: 70 },
    render: () => (
      <g>
        <path d="M100 26 C 62 26, 36 52, 36 86 C 36 110, 52 126, 68 138 L 68 148 A 6 6 0 0 0 74 154 L 126 154 A 6 6 0 0 0 132 148 L 132 138 C 148 126, 164 110, 164 86 C 164 52, 138 26, 100 26 Z" {...sp()} />
        <path d="M76 162 L124 162" {...lp(SW_INNER)} />
        <path d="M82 172 L118 172" {...lp(SW_INNER)} />
      </g>
    ),
  },
  folder: {
    name: "Folder",
    face: { cx: 100, cy: 118, w: 90 },
    render: () => (
      <path d="M30 64 A 10 10 0 0 1 40 54 L 84 54 L 96 66 L 160 66 A 10 10 0 0 1 170 76 L 170 158 A 10 10 0 0 1 160 168 L 40 168 A 10 10 0 0 1 30 158 Z" {...sp()} />
    ),
  },
  mountain: {
    name: "Mountain",
    face: { cx: 100, cy: 130, w: 70 },
    render: () => (
      <g>
        <path d="M28 168 L100 56 L172 168 Z" {...sp()} />
        <path d="M100 56 L100 28" {...lpf(SW_INNER)} />
        <path d="M100 30 L122 38 L100 46" {...sp(SW_INNER)} />
      </g>
    ),
  },
};

export const SHAPE_KEYS = Object.keys(Shapes);

// ─────────────────────────────────────────────────────────────
// NOSES
// ─────────────────────────────────────────────────────────────
export interface NoseDef {
  name: string;
  render: () => ReactNode;
}

export const Noses: Record<string, NoseDef> = {
  dot:   { name: "Dot",    render: () => <circle cx="0" cy="0" r="3.2" {...fp} /> },
  dash:  { name: "Dash",   render: () => <line x1="-8" y1="0" x2="8" y2="0" {...lpf(SW_FACE)} /> },
  hookL: { name: "Hook",   render: () => <path d="M-4 -6 L-4 5 L7 5" {...lpf(SW_FACE)} /> },
  smile: { name: "Smile",  render: () => <path d="M-8 -3 Q0 7 8 -3" {...lpf(SW_FACE)} /> },
  caret: { name: "Caret",  render: () => <path d="M-8 5 L0 -5 L8 5" {...lpf(SW_FACE)} /> },
  arrow: { name: "Arrow",  render: () => <path d="M-8 -3 L0 4 L8 -3" {...lpf(SW_FACE)} /> },
  oh:    { name: "o",      render: () => <circle cx="0" cy="0" r="4" {...lpf(SW_FACE - 1)} /> },
};

export const NOSE_KEYS = Object.keys(Noses);

// ─────────────────────────────────────────────────────────────
// EYES
// ─────────────────────────────────────────────────────────────
export interface EyeDef {
  name: string;
  render: (dx: number) => ReactNode;
}

const eye = (l: ReactNode, r: ReactNode = l) => {
  const EyePair = (dx: number) => (
  <g>
    <g transform={`translate(${-dx}, 0)`}>{l}</g>
    <g transform={`translate(${dx}, 0)`}>{r}</g>
  </g>
  );
  EyePair.displayName = "EyePair";
  return EyePair;
};

export const Eyes: Record<string, EyeDef> = {
  dots: { name: "Dots", render: eye(<circle cx="0" cy="0" r="4.5" {...fp} />) },
  big: {
    name: "Big",
    render: eye(
      <g>
        <circle cx="0" cy="0" r="7" {...sp(SW_FACE - 1)} />
        <circle cx="2" cy="-2" r="2" {...fp} />
      </g>
    ),
  },
  rings:  { name: "Rings",  render: eye(<circle cx="0" cy="0" r="5" {...lpf(SW_FACE - 1)} />) },
  arches: { name: "Arches", render: eye(<path d="M-7 3 Q0 -7 7 3" {...lpf(SW_FACE)} />) },
  lines:  { name: "Lines",  render: eye(<line x1="-7" y1="0" x2="7" y2="0" {...lpf(SW_FACE)} />) },
  happy:  { name: "Happy",  render: eye(<path d="M-7 3 L0 -5 L7 3" {...lpf(SW_FACE)} />) },
  sleepy: { name: "Sleepy", render: eye(<path d="M-7 -2 Q0 6 7 -2" {...lpf(SW_FACE)} />) },
  shy: {
    name: "Shy",
    render: eye(<path d="M-6 -3 A6 6 0 0 1 6 -3 L6 1 A6 6 0 0 1 -6 1 Z" {...fp} />),
  },
  wink: {
    name: "Wink",
    render: (dx: number) => (
      <g>
        <g transform={`translate(${-dx}, 0)`}><circle cx="0" cy="0" r="4.5" {...fp} /></g>
        <g transform={`translate(${dx}, 0)`}><path d="M-7 1 Q0 -6 7 1" {...lpf(SW_FACE)} /></g>
      </g>
    ),
  },
};

export const EYE_KEYS = Object.keys(Eyes);

// ─────────────────────────────────────────────────────────────
// AVATAR CONFIG
// ─────────────────────────────────────────────────────────────
export interface AvatarConfig {
  shape: string;
  eye: string;
  nose: string;
  bg: number;
}

export const DEFAULT_CONFIG: AvatarConfig = {
  shape: "book",
  eye: "happy",
  nose: "dash",
  bg: 1,
};

// ─────────────────────────────────────────────────────────────
// PRESETS
// ─────────────────────────────────────────────────────────────
export interface Preset {
  name: string;
  config: AvatarConfig;
}

export const PRESETS: Preset[] = [
  { name: "Task",     config: { shape: "task",     nose: "dot",   eye: "dots",   bg: 0 } },
  { name: "Notes",    config: { shape: "book",     nose: "dash",  eye: "happy",  bg: 1 } },
  { name: "Mail",     config: { shape: "mail",     nose: "smile", eye: "dots",   bg: 3 } },
  { name: "Schedule", config: { shape: "calendar", nose: "dot",   eye: "dots",   bg: 4 } },
  { name: "Idea",     config: { shape: "bulb",     nose: "oh",    eye: "rings",  bg: 5 } },
  { name: "Project",  config: { shape: "folder",   nose: "dash",  eye: "lines",  bg: 7 } },
  { name: "Goal",     config: { shape: "mountain", nose: "caret", eye: "arches", bg: 8 } },
  { name: "Dream",    config: { shape: "circle",   nose: "smile", eye: "shy",    bg: 11 } },
  { name: "Organize", config: { shape: "rounded",  nose: "dot",   eye: "sleepy", bg: 6 } },
  { name: "Explore",  config: { shape: "hexagon",  nose: "hookL", eye: "wink",   bg: 9 } },
  { name: "Focus",    config: { shape: "task",     nose: "caret", eye: "lines",  bg: 2 } },
  { name: "Collect",  config: { shape: "book",     nose: "oh",    eye: "rings",  bg: 10 } },
];

// ─────────────────────────────────────────────────────────────
// RANDOM CONFIG
// ─────────────────────────────────────────────────────────────
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function randomConfig(): AvatarConfig {
  return {
    shape: pick(SHAPE_KEYS),
    eye: pick(EYE_KEYS),
    nose: pick(NOSE_KEYS),
    bg: Math.floor(Math.random() * BG_COLORS.length),
  };
}

// ─────────────────────────────────────────────────────────────
// AVATAR RENDERER
// ─────────────────────────────────────────────────────────────
interface AvatarRendererProps {
  config: AvatarConfig;
  size?: number;
  className?: string;
}

export function AvatarRenderer({ config, size = 200, className }: AvatarRendererProps) {
  const sh = Shapes[config.shape] ?? Shapes.book!;
  const ey = Eyes[config.eye];
  const no = Noses[config.nose];
  const bgColor = BG_COLORS[config.bg]?.value ?? BG_COLORS[0]!.value;

  const { cx, cy, w } = sh.face;
  const eyeDx = Math.max(11, w * 0.22);
  const eyeY = cy - Math.max(10, w * 0.14);

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={className}
      style={{ display: "block" }}
    >
      <rect x="0" y="0" width="200" height="200" rx="56" fill={bgColor} />
      <g transform="translate(100,100) scale(0.85) translate(-100,-100)">
        <g data-avatar-shape="">{sh.render()}</g>
        {ey && <g transform={`translate(${cx}, ${eyeY})`}><g data-avatar-eyes="">{ey.render(eyeDx)}</g></g>}
        {no && <g transform={`translate(${cx}, ${cy + 5})`}><g data-avatar-nose="">{no.render()}</g></g>}
      </g>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// SERIALIZE / DESERIALIZE
// ─────────────────────────────────────────────────────────────
const AVATAR_PREFIX = "avatar:";

export function serializeAvatarConfig(config: AvatarConfig): string {
  return AVATAR_PREFIX + JSON.stringify(config);
}

function isValidAvatarConfig(obj: unknown): obj is AvatarConfig {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  return (
    typeof rec.shape === "string" &&
    typeof rec.eye === "string" &&
    typeof rec.nose === "string" &&
    typeof rec.bg === "number"
  );
}

export function parseAvatarUrl(avatarUrl: string | null | undefined): AvatarConfig | null {
  if (!avatarUrl || !avatarUrl.startsWith(AVATAR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(avatarUrl.slice(AVATAR_PREFIX.length));
    if (isValidAvatarConfig(parsed)) return parsed;
    // Fallback for old format (had "outline"/"eyes"/"bgColor" fields)
    if (typeof parsed === "object" && parsed !== null && "outline" in parsed) {
      return DEFAULT_CONFIG;
    }
    return null;
  } catch {
    return null;
  }
}

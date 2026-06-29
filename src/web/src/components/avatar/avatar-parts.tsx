import { useId } from "react";
import type { ReactNode } from "react";

// ─────────────────────────────────────────────────────────────
// STYLE CONSTANTS
// ─────────────────────────────────────────────────────────────
const SHAPE_FILL = "rgba(255,255,255,0.92)";
const SHAPE_STROKE = "rgba(255,255,255,0.95)";
const SHAPE_SW = 3.5;
const DEFAULT_FACE_COLOR = "#27272a";

const shapeStyle = { fill: SHAPE_FILL, stroke: SHAPE_STROKE, strokeWidth: SHAPE_SW };

// ─────────────────────────────────────────────────────────────
// PALETTES
// ─────────────────────────────────────────────────────────────
export interface ColorOption {
  name: string;
  value: string;
  gradient: [string, string, string];
  faceColor: string;
}

export const BG_COLORS: ColorOption[] = [
  { name: "Purple",      value: "#a855f7", gradient: ["#c084fc", "#a855f7", "#7c3aed"], faceColor: "#2e1065" },
  { name: "Teal",        value: "#14b8a6", gradient: ["#5eead4", "#14b8a6", "#0d9488"], faceColor: "#134e4a" },
  { name: "Orange",      value: "#f97316", gradient: ["#fdba74", "#f97316", "#c2410c"], faceColor: "#7c2d12" },
  { name: "Blue",        value: "#3b82f6", gradient: ["#93c5fd", "#3b82f6", "#1d4ed8"], faceColor: "#1e3a5f" },
  { name: "Pink",        value: "#f472b6", gradient: ["#fda4af", "#f472b6", "#be185d"], faceColor: "#831843" },
  { name: "Yellow",      value: "#eab308", gradient: ["#fde047", "#eab308", "#a16207"], faceColor: "#713f12" },
  { name: "Green",       value: "#22c55e", gradient: ["#86efac", "#22c55e", "#15803d"], faceColor: "#14532d" },
  { name: "Beige",       value: "#d6ccb8", gradient: ["#e8e0d4", "#d6ccb8", "#b8a990"], faceColor: "#57534e" },
  { name: "Red",         value: "#ef4444", gradient: ["#fca5a5", "#ef4444", "#991b1b"], faceColor: "#7f1d1d" },
  { name: "Lake Blue",   value: "#6366f1", gradient: ["#a5b4fc", "#6366f1", "#3730a3"], faceColor: "#312e81" },
  { name: "Gray",        value: "#9ca3af", gradient: ["#d4d4d8", "#9ca3af", "#6b7280"], faceColor: "#374151" },
  { name: "Deep Purple", value: "#8b5cf6", gradient: ["#c4b5fd", "#8b5cf6", "#5b21b6"], faceColor: "#3b0764" },
];

// ─────────────────────────────────────────────────────────────
// SHAPES (rounded silhouettes only)
// ─────────────────────────────────────────────────────────────
export interface ShapeDef {
  name: string;
  face: { cx: number; cy: number; w: number };
  render: () => ReactNode;
}

export const Shapes: Record<string, ShapeDef> = {
  circle: {
    name: "Circle",
    face: { cx: 100, cy: 100, w: 80 },
    render: () => <circle cx="100" cy="100" r="66" {...shapeStyle} />,
  },
  rounded: {
    name: "Rounded",
    face: { cx: 100, cy: 100, w: 90 },
    render: () => <rect x="30" y="30" width="140" height="140" rx="32" {...shapeStyle} />,
  },
  hexagon: {
    name: "Hexagon",
    face: { cx: 100, cy: 100, w: 86 },
    render: () => (
      <path d="M100 32 C108 32 114 35 120 39 L155 60 C161 64 165 70 165 78 L165 122 C165 130 161 136 155 140 L120 161 C114 165 108 168 100 168 C92 168 86 165 80 161 L45 140 C39 136 35 130 35 122 L35 78 C35 70 39 64 45 60 L80 39 C86 35 92 32 100 32 Z" {...shapeStyle} />
    ),
  },
  task: {
    name: "Task",
    face: { cx: 100, cy: 100, w: 80 },
    render: () => <rect x="34" y="34" width="132" height="132" rx="24" {...shapeStyle} />,
  },
  book: {
    name: "Book",
    face: { cx: 100, cy: 100, w: 80 },
    render: () => (
      <path d="M42 162 L42 88 C42 54 68 34 100 34 C132 34 158 54 158 88 L158 162 C158 166 154 170 150 170 L50 170 C46 170 42 166 42 162 Z" {...shapeStyle} />
    ),
  },
  mail: {
    name: "Mail",
    face: { cx: 100, cy: 100, w: 86 },
    render: () => <rect x="28" y="54" width="144" height="92" rx="46" {...shapeStyle} />,
  },
  calendar: {
    name: "Calendar",
    face: { cx: 100, cy: 100, w: 80 },
    render: () => (
      <path d="M100 34 C138 34 166 52 166 80 C166 94 158 106 158 118 C158 148 138 166 100 166 C62 166 42 148 42 118 C42 106 34 94 34 80 C34 52 62 34 100 34 Z" {...shapeStyle} />
    ),
  },
  bulb: {
    name: "Bulb",
    face: { cx: 100, cy: 104, w: 76 },
    render: () => <ellipse cx="100" cy="104" rx="58" ry="66" {...shapeStyle} />,
  },
  folder: {
    name: "Folder",
    face: { cx: 102, cy: 108, w: 80 },
    render: () => (
      <path d="M62 144 C40 144 32 128 36 116 C32 104 40 90 54 88 C56 72 70 60 88 62 C100 50 118 50 132 58 C144 52 162 60 162 76 C172 82 174 98 166 108 C172 120 164 136 150 140 Z" {...shapeStyle} />
    ),
  },
  mountain: {
    name: "Mountain",
    face: { cx: 100, cy: 100, w: 76 },
    render: () => (
      <path d="M92 36 C120 32 156 48 164 78 C172 108 156 148 124 160 C92 172 48 156 38 124 C28 92 62 40 92 36 Z" {...shapeStyle} />
    ),
  },
};

export const SHAPE_KEYS = Object.keys(Shapes);

// ─────────────────────────────────────────────────────────────
// NOSES (mouths)
// ─────────────────────────────────────────────────────────────
export interface NoseDef {
  name: string;
  render: (color?: string) => ReactNode;
}

export const Noses: Record<string, NoseDef> = {
  dot: {
    name: "Dot",
    render: (c = DEFAULT_FACE_COLOR) => <circle cx="0" cy="0" r="4.5" fill={c} />,
  },
  dash: {
    name: "Dash",
    render: (c = DEFAULT_FACE_COLOR) => <line x1="-10" y1="0" x2="10" y2="0" stroke={c} strokeWidth="5" strokeLinecap="round" />,
  },
  hookL: {
    name: "Hook",
    render: (c = DEFAULT_FACE_COLOR) => <path d="M-11 0 Q-5.5 7 0 1.5 Q5.5 7 11 0" fill="none" stroke={c} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />,
  },
  smile: {
    name: "Smile",
    render: (c = DEFAULT_FACE_COLOR) => <path d="M-11 0 Q0 11 11 0" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" />,
  },
  caret: {
    name: "Caret",
    render: (c = DEFAULT_FACE_COLOR) => (
      <g>
        <path d="M-10 0 Q0 8 10 0" fill="none" stroke={c} strokeWidth="4.5" strokeLinecap="round" />
        <ellipse cx="3" cy="6" rx="4" ry="4.5" fill="#f472b6" />
      </g>
    ),
  },
  arrow: {
    name: "Arrow",
    render: (c = DEFAULT_FACE_COLOR) => <ellipse cx="0" cy="0" rx="6" ry="7.5" fill={c} />,
  },
  oh: {
    name: "o",
    render: (c = DEFAULT_FACE_COLOR) => <ellipse cx="0" cy="0" rx="7" ry="7.5" fill="none" stroke={c} strokeWidth="4.5" />,
  },
};

export const NOSE_KEYS = Object.keys(Noses);

// ─────────────────────────────────────────────────────────────
// EYES
// ─────────────────────────────────────────────────────────────
export interface EyeDef {
  name: string;
  render: (dx: number, color?: string) => ReactNode;
}

const eye = (l: (c: string) => ReactNode, r?: (c: string) => ReactNode) => {
  const rFn = r ?? l;
  const EyePair = (dx: number, c = DEFAULT_FACE_COLOR) => (
    <g>
      <g transform={`translate(${-dx}, 0)`}>{l(c)}</g>
      <g transform={`translate(${dx}, 0)`}>{rFn(c)}</g>
    </g>
  );
  EyePair.displayName = "EyePair";
  return EyePair;
};

export const Eyes: Record<string, EyeDef> = {
  dots: {
    name: "Dots",
    render: eye((c) => <circle cx="0" cy="0" r="7" fill={c} />),
  },
  big: {
    name: "Big",
    render: eye((c) => (
      <g>
        <circle cx="0" cy="0" r="10" fill={c} />
        <circle cx="2.5" cy="-3" r="3.5" fill="rgba(255,255,255,0.9)" />
      </g>
    )),
  },
  rings: {
    name: "Rings",
    render: eye((c) => <ellipse cx="0" cy="0" rx="8.5" ry="9.5" fill="none" stroke={c} strokeWidth="4.5" />),
  },
  arches: {
    name: "Arches",
    render: eye((c) => <path d="M-10 2 Q0 -9 10 2" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" />),
  },
  lines: {
    name: "Lines",
    render: eye((c) => <path d="M-10 0 Q0 -6 10 0" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" />),
  },
  happy: {
    name: "Happy",
    render: eye((c) => <path d="M-10 5 Q0 -11 10 5" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" />),
  },
  sleepy: {
    name: "Sleepy",
    render: eye((c) => <path d="M-10 -2 Q0 8 10 -2" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" />),
  },
  shy: {
    name: "Shy",
    render: eye((c) => <ellipse cx="0" cy="0" rx="8.5" ry="9.5" fill={c} />),
  },
  wink: {
    name: "Wink",
    render: (dx: number, c = DEFAULT_FACE_COLOR) => (
      <g>
        <g transform={`translate(${-dx}, 0)`}><circle cx="0" cy="0" r="7" fill={c} /></g>
        <g transform={`translate(${dx}, 0)`}><path d="M-10 2 Q0 -9 10 2" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" /></g>
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
// DETERMINISTIC CONFIG FROM NAME
// ─────────────────────────────────────────────────────────────
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function configFromName(name: string): AvatarConfig {
  const h = hashStr(name.toLowerCase());
  return {
    shape: SHAPE_KEYS[h % SHAPE_KEYS.length]!,
    eye: EYE_KEYS[(h >>> 4) % EYE_KEYS.length]!,
    nose: NOSE_KEYS[(h >>> 8) % NOSE_KEYS.length]!,
    bg: (h >>> 12) % BG_COLORS.length,
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
  const uid = useId().replace(/:/g, "");
  const sh = Shapes[config.shape] ?? Shapes.book!;
  const ey = Eyes[config.eye];
  const no = Noses[config.nose];
  const bgEntry = BG_COLORS[config.bg] ?? BG_COLORS[0]!;
  const [g0, g1, g2] = bgEntry.gradient;
  const faceColor = bgEntry.faceColor;

  const { cx, cy, w } = sh.face;
  const eyeDx = Math.max(13, w * 0.24);
  const eyeY = cy - Math.max(12, w * 0.16);

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={className}
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={`bg-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={g0} />
          <stop offset="50%" stopColor={g1} />
          <stop offset="100%" stopColor={g2} />
        </linearGradient>
        <radialGradient id={`gl-${uid}`} cx="30%" cy="25%" r="60%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.32)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <filter id={`sh-${uid}`} x="-10%" y="-5%" width="120%" height="130%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="rgba(0,0,0,0.18)" />
        </filter>
      </defs>
      <rect x="0" y="0" width="200" height="200" rx="56" fill={`url(#bg-${uid})`} />
      <rect x="0" y="0" width="200" height="200" rx="56" fill={`url(#gl-${uid})`} />
      <g transform="translate(100,100) scale(0.8) translate(-100,-100)">
        <g data-avatar-shape="" filter={`url(#sh-${uid})`}>{sh.render()}</g>
        {ey && <g transform={`translate(${cx}, ${eyeY})`}><g data-avatar-eyes="">{ey.render(eyeDx, faceColor)}</g></g>}
        {no && <g transform={`translate(${cx}, ${cy + 7})`}><g data-avatar-nose="">{no.render(faceColor)}</g></g>}
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
    if (typeof parsed === "object" && parsed !== null && "outline" in parsed) {
      return DEFAULT_CONFIG;
    }
    return null;
  } catch {
    return null;
  }
}

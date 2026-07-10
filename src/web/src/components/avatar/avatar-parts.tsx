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
// GEOMETRY HELPERS — build rounded-corner polygon paths (used for
// star/pentagon/octagon/bolt so every vertex reads as soft, not spiky)
// ─────────────────────────────────────────────────────────────
type Point = [number, number];

function pointDist(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function lerpTowards(from: Point, to: Point, distance: number): Point {
  const d = pointDist(from, to);
  if (d === 0) return from;
  const t = Math.min(distance, d) / d;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

function fmtPoint([x, y]: Point): string {
  return `${x.toFixed(1)} ${y.toFixed(1)}`;
}

function roundedPolygonPath(pts: Point[], radius: number | ((i: number) => number)): string {
  const n = pts.length;
  const d: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]!;
    const curr = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const r = typeof radius === "function" ? radius(i) : radius;
    const pa = lerpTowards(curr, prev, r);
    const pb = lerpTowards(curr, next, r);
    d.push(i === 0 ? `M${fmtPoint(pa)}` : `L${fmtPoint(pa)}`);
    d.push(`Q${fmtPoint(curr)} ${fmtPoint(pb)}`);
  }
  d.push("Z");
  return d.join(" ");
}

function polygonPoints(cx: number, cy: number, radii: number[], startDeg: number): Point[] {
  const step = 360 / radii.length;
  return radii.map((r, i) => {
    const a = ((startDeg + i * step) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

const STAR_PATH = roundedPolygonPath(
  polygonPoints(100, 100, [74, 36, 74, 36, 74, 36, 74, 36, 74, 36], -90),
  (i) => (i % 2 === 0 ? 15 : 9)
);
const PENTAGON_PATH = roundedPolygonPath(polygonPoints(100, 104, [74, 74, 74, 74, 74], -90), 16);
const OCTAGON_PATH = roundedPolygonPath(polygonPoints(100, 100, new Array(8).fill(72), -67.5), 14);
const BOLT_PATH = roundedPolygonPath(
  [[112, 28], [66, 104], [96, 104], [82, 174], [140, 92], [108, 92]],
  7
);
const TRIANGLE_PATH = roundedPolygonPath(polygonPoints(100, 110, [80, 80, 80], -90), 20);
const CROWN_PATH = roundedPolygonPath(
  [[40, 130], [54, 60], [74, 100], [100, 40], [126, 100], [146, 60], [160, 130], [160, 172], [40, 172]],
  (i) => (i === 7 || i === 8 ? 12 : 7)
);
const GEM_PATH = roundedPolygonPath(
  [[58, 66], [86, 38], [114, 38], [142, 66], [100, 172]],
  9
);
const MOON_PATH = "M163.8 105.6 A63.75 63.75 0 1 1 94.4 36.3 A49.6 49.6 0 0 0 163.8 105.6 Z";

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
  { name: "Purple", value: "#a855f7", gradient: ["#c084fc", "#a855f7", "#7c3aed"], faceColor: "#2e1065" },
  { name: "Teal", value: "#14b8a6", gradient: ["#5eead4", "#14b8a6", "#0d9488"], faceColor: "#134e4a" },
  { name: "Orange", value: "#f97316", gradient: ["#fdba74", "#f97316", "#c2410c"], faceColor: "#7c2d12" },
  { name: "Blue", value: "#3b82f6", gradient: ["#93c5fd", "#3b82f6", "#1d4ed8"], faceColor: "#1e3a5f" },
  { name: "Pink", value: "#f472b6", gradient: ["#fda4af", "#f472b6", "#be185d"], faceColor: "#831843" },
  { name: "Yellow", value: "#eab308", gradient: ["#fde047", "#eab308", "#a16207"], faceColor: "#713f12" },
  { name: "Green", value: "#22c55e", gradient: ["#86efac", "#22c55e", "#15803d"], faceColor: "#14532d" },
  { name: "Beige", value: "#d6ccb8", gradient: ["#e8e0d4", "#d6ccb8", "#b8a990"], faceColor: "#57534e" },
  { name: "Red", value: "#ef4444", gradient: ["#fca5a5", "#ef4444", "#991b1b"], faceColor: "#7f1d1d" },
  { name: "Lake Blue", value: "#6366f1", gradient: ["#a5b4fc", "#6366f1", "#3730a3"], faceColor: "#312e81" },
  { name: "Gray", value: "#9ca3af", gradient: ["#d4d4d8", "#9ca3af", "#6b7280"], faceColor: "#374151" },
  { name: "Deep Purple", value: "#8b5cf6", gradient: ["#c4b5fd", "#8b5cf6", "#5b21b6"], faceColor: "#3b0764" },
  { name: "Coral", value: "#fb7185", gradient: ["#fecdd3", "#fb7185", "#be123c"], faceColor: "#881337" },
  { name: "Mint", value: "#2dd4bf", gradient: ["#99f6e4", "#2dd4bf", "#0f766e"], faceColor: "#134e4a" },
  { name: "Indigo", value: "#4f46e5", gradient: ["#a5b4fc", "#4f46e5", "#3730a3"], faceColor: "#1e1b4b" },
  { name: "Rose", value: "#e11d48", gradient: ["#fda4af", "#e11d48", "#881337"], faceColor: "#4c0519" },
  { name: "Amber", value: "#f59e0b", gradient: ["#fcd34d", "#f59e0b", "#b45309"], faceColor: "#78350f" },
  { name: "Cyan", value: "#06b6d4", gradient: ["#67e8f9", "#06b6d4", "#0e7490"], faceColor: "#164e63" },
  { name: "Slate", value: "#64748b", gradient: ["#cbd5e1", "#64748b", "#334155"], faceColor: "#1e293b" },
  { name: "Lime", value: "#84cc16", gradient: ["#d9f99d", "#84cc16", "#4d7c0f"], faceColor: "#365314" },
  { name: "Sky", value: "#0ea5e9", gradient: ["#7dd3fc", "#0ea5e9", "#0369a1"], faceColor: "#0c4a6e" },
  { name: "Fuchsia", value: "#d946ef", gradient: ["#f0abfc", "#d946ef", "#a21caf"], faceColor: "#4a044e" },
  { name: "Emerald", value: "#059669", gradient: ["#6ee7b7", "#059669", "#047857"], faceColor: "#022c22" },
  { name: "Sand", value: "#d4a373", gradient: ["#f0dcc4", "#d4a373", "#a67c52"], faceColor: "#4a2e17" },
  { name: "Copper", value: "#c2703d", gradient: ["#e8b088", "#c2703d", "#8a4a1f"], faceColor: "#431f0a" },
  { name: "Charcoal", value: "#52525b", gradient: ["#a1a1aa", "#52525b", "#27272a"], faceColor: "#18181b" },
  { name: "Denim", value: "#4a7ba6", gradient: ["#93b8d4", "#4a7ba6", "#2c5170"], faceColor: "#16283a" },
  { name: "Plum", value: "#8e4585", gradient: ["#d8a8d1", "#8e4585", "#5c2a55"], faceColor: "#2e1330" },
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
  chat: {
    name: "Chat",
    face: { cx: 100, cy: 86, w: 76 },
    render: () => (
      <path d="M54 34 L146 34 C162 34 174 46 174 62 L174 118 C174 134 162 146 146 146 L90 146 L58 176 L54 146 C38 146 26 134 26 118 L26 62 C26 46 38 34 54 34 Z" {...shapeStyle} />
    ),
  },
  shield: {
    name: "Shield",
    face: { cx: 100, cy: 94, w: 74 },
    render: () => (
      <path d="M100 30 L156 50 C160 52 162 56 162 60 L162 96 C162 132 136 158 100 172 C64 158 38 132 38 96 L38 60 C38 56 40 52 44 50 Z" {...shapeStyle} />
    ),
  },
  heart: {
    name: "Heart",
    face: { cx: 100, cy: 92, w: 78 },
    render: () => (
      <path d="M100 168 C40 128 24 92 34 66 C44 40 78 34 100 62 C122 34 156 40 166 66 C176 92 160 128 100 168 Z" {...shapeStyle} />
    ),
  },
  star: {
    name: "Star",
    face: { cx: 100, cy: 100, w: 60 },
    render: () => <path d={STAR_PATH} {...shapeStyle} />,
  },
  diamond: {
    name: "Diamond",
    face: { cx: 100, cy: 103, w: 78 },
    render: () => (
      <path d="M100 26 C106 26 111 29 115 34 L168 92 C174 98 174 108 168 114 L115 172 C111 177 106 180 100 180 C94 180 89 177 85 172 L32 114 C26 108 26 98 32 92 L85 34 C89 29 94 26 100 26 Z" {...shapeStyle} />
    ),
  },
  cloud: {
    name: "Cloud",
    face: { cx: 100, cy: 106, w: 80 },
    render: () => (
      <path d="M60 140 C42 140 30 126 30 110 C30 96 40 84 54 82 C58 62 76 48 98 48 C118 48 134 60 140 78 C158 78 172 92 172 110 C172 126 160 138 144 140 Z" {...shapeStyle} />
    ),
  },
  pentagon: {
    name: "Pentagon",
    face: { cx: 100, cy: 106, w: 76 },
    render: () => <path d={PENTAGON_PATH} {...shapeStyle} />,
  },
  octagon: {
    name: "Octagon",
    face: { cx: 100, cy: 100, w: 82 },
    render: () => <path d={OCTAGON_PATH} {...shapeStyle} />,
  },
  bolt: {
    name: "Bolt",
    face: { cx: 103, cy: 90, w: 66 },
    render: () => <path d={BOLT_PATH} {...shapeStyle} />,
  },
  flag: {
    name: "Flag",
    face: { cx: 100, cy: 84, w: 76 },
    render: () => (
      <path d="M62 30 L138 30 C146 30 152 36 152 44 L152 150 L100 122 L48 150 L48 44 C48 36 54 30 62 30 Z" {...shapeStyle} />
    ),
  },
  leaf: {
    name: "Leaf",
    face: { cx: 103, cy: 102, w: 76 },
    render: () => (
      <path d="M100 26 C136 44 162 74 162 108 C162 144 132 172 104 176 C98 177 92 174 92 168 C68 160 48 136 44 108 C40 74 64 44 100 26 Z" {...shapeStyle} />
    ),
  },
  drop: {
    name: "Drop",
    face: { cx: 100, cy: 122, w: 74 },
    render: () => (
      <path d="M100 28 C130 66 152 96 152 124 C152 152 128 172 100 172 C72 172 48 152 48 124 C48 96 70 66 100 28 Z" {...shapeStyle} />
    ),
  },
  triangle: {
    name: "Triangle",
    face: { cx: 100, cy: 122, w: 64 },
    render: () => <path d={TRIANGLE_PATH} {...shapeStyle} />,
  },
  crown: {
    name: "Crown",
    face: { cx: 100, cy: 150, w: 72 },
    render: () => <path d={CROWN_PATH} {...shapeStyle} />,
  },
  gem: {
    name: "Gem",
    face: { cx: 100, cy: 86, w: 64 },
    render: () => <path d={GEM_PATH} {...shapeStyle} />,
  },
  moon: {
    name: "Moon",
    face: { cx: 86, cy: 82, w: 40 },
    render: () => <path d={MOON_PATH} {...shapeStyle} />,
  },
  trophy: {
    name: "Trophy",
    face: { cx: 100, cy: 72, w: 76 },
    render: () => (
      <path d="M54 34 L146 34 C146 34 150 34 150 40 C150 78 130 104 108 110 L108 128 L134 128 C140 128 144 132 144 138 L144 158 C144 164 140 168 134 168 L66 168 C60 168 56 164 56 158 L56 138 C56 132 60 128 66 128 L92 128 L92 110 C70 104 50 78 50 40 C50 34 54 34 54 34 Z" {...shapeStyle} />
    ),
  },
  rocket: {
    name: "Rocket",
    face: { cx: 100, cy: 88, w: 54 },
    render: () => (
      <g>
        <path d="M100 30 C118 30 132 62 132 96 C132 108 128 118 124 126 L124 150 L76 150 L76 126 C72 118 68 108 68 96 C68 62 82 30 100 30 Z" {...shapeStyle} />
        <path d="M68 118 C50 118 40 140 44 158 C52 148 62 140 74 138 Z" {...shapeStyle} />
        <path d="M132 118 C150 118 160 140 156 158 C148 148 138 140 126 138 Z" {...shapeStyle} />
      </g>
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
  grin: {
    name: "Grin",
    render: (c = DEFAULT_FACE_COLOR) => (
      <g>
        <path d="M-11 0 Q0 10 11 0" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" />
        <line x1="-7" y1="4" x2="7" y2="4" stroke={c} strokeWidth="3" strokeLinecap="round" />
      </g>
    ),
  },
  gasp: {
    name: "Gasp",
    render: (c = DEFAULT_FACE_COLOR) => <rect x="-6" y="-2" width="12" height="13" rx="6" fill={c} />,
  },
  zigzag: {
    name: "Zigzag",
    render: (c = DEFAULT_FACE_COLOR) => (
      <path d="M-11 0 L-5 4 L1 -3 L7 4 L11 0" fill="none" stroke={c} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  pucker: {
    name: "Pucker",
    render: (c = DEFAULT_FACE_COLOR) => <path d="M-3 -5 Q4 -5 4 0 Q4 5 -3 5 Q2 0 -3 -5 Z" fill={c} />,
  },
  smirk: {
    name: "Smirk",
    render: (c = DEFAULT_FACE_COLOR) => (
      <path d="M-9 2 Q-2 2 3 -5 L11 -5" fill="none" stroke={c} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    ),
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
  cat: {
    name: "Cat",
    render: (dx: number, c = DEFAULT_FACE_COLOR) => (
      <g>
        <g transform={`translate(${-dx}, 0)`}>
          <path d="M-11 2 C-11 -6 -2 -10 7 -6 C12 -3 10 4 4 6 C-3 9 -11 8 -11 2 Z" fill={c} />
        </g>
        <g transform={`translate(${dx}, 0) scale(-1, 1)`}>
          <path d="M-11 2 C-11 -6 -2 -10 7 -6 C12 -3 10 4 4 6 C-3 9 -11 8 -11 2 Z" fill={c} />
        </g>
      </g>
    ),
  },
  glasses: {
    name: "Glasses",
    render: (dx: number, c = DEFAULT_FACE_COLOR) => (
      <g>
        <line x1={-dx + 9} y1="0" x2={dx - 9} y2="0" stroke={c} strokeWidth="3.5" />
        <g transform={`translate(${-dx}, 0)`}><circle cx="0" cy="0" r="9" fill="none" stroke={c} strokeWidth="4.5" /></g>
        <g transform={`translate(${dx}, 0)`}><circle cx="0" cy="0" r="9" fill="none" stroke={c} strokeWidth="4.5" /></g>
      </g>
    ),
  },
  heart: {
    name: "Heart",
    render: eye(() => (
      <path
        d="M0 5 C-6 0 -10 -4 -6 -8 C-3 -10 0 -8 0 -6 C0 -8 3 -10 6 -8 C10 -4 6 0 0 5 Z"
        fill="#f472b6"
      />
    )),
  },
  star: {
    name: "Star",
    render: eye((c) => (
      <path d="M0 -9 C1 -3 3 -1 9 0 C3 1 1 3 0 9 C-1 3 -3 1 -9 0 C-3 -1 -1 -3 0 -9 Z" fill={c} />
    )),
  },
  surprised: {
    name: "Surprised",
    render: eye((c) => (
      <g>
        <circle cx="0" cy="0" r="11" fill="none" stroke={c} strokeWidth="4" />
        <circle cx="0" cy="0" r="4" fill={c} />
      </g>
    )),
  },
  sparkle: {
    name: "Sparkle",
    render: eye((c) => (
      <g>
        <circle cx="0" cy="0" r="9" fill={c} />
        <path
          d="M3 -7 C3.5 -4 4 -3.5 7 -3 C4 -2.5 3.5 -2 3 1 C2.5 -2 2 -2.5 -1 -3 C2 -3.5 2.5 -4 3 -7 Z"
          fill="rgba(255,255,255,0.9)"
        />
      </g>
    )),
  },
  square: {
    name: "Square",
    render: eye((c) => <rect x="-7" y="-7" width="14" height="14" rx="4" fill={c} />),
  },
  cross: {
    name: "Cross",
    render: eye((c) => (
      <g>
        <line x1="-7" y1="-7" x2="7" y2="7" stroke={c} strokeWidth="4" strokeLinecap="round" />
        <line x1="-7" y1="7" x2="7" y2="-7" stroke={c} strokeWidth="4" strokeLinecap="round" />
      </g>
    )),
  },
  triangle: {
    name: "Triangle",
    render: eye((c) => <path d="M0 -9 Q2 -9 3 -7 L8 6 Q9 8 7 8 L-7 8 Q-9 8 -8 6 L-3 -7 Q-2 -9 0 -9 Z" fill={c} />),
  },
  target: {
    name: "Target",
    render: eye((c) => (
      <g>
        <circle cx="0" cy="0" r="9" fill="none" stroke={c} strokeWidth="2.5" />
        <circle cx="0" cy="0" r="4" fill="none" stroke={c} strokeWidth="2.5" />
      </g>
    )),
  },
  puppy: {
    name: "Puppy",
    render: eye((c) => (
      <g>
        <ellipse cx="0" cy="1" rx="9" ry="10" fill={c} />
        <circle cx="-3" cy="-4" r="3" fill="rgba(255,255,255,0.9)" />
        <circle cx="3.5" cy="1" r="1.8" fill="rgba(255,255,255,0.7)" />
      </g>
    )),
  },
  angry: {
    name: "Angry",
    render: (dx: number, c = DEFAULT_FACE_COLOR) => (
      <g>
        <g transform={`translate(${-dx}, 0)`}><path d="M-8 -6 L8 2" stroke={c} strokeWidth="5" strokeLinecap="round" /></g>
        <g transform={`translate(${dx}, 0) scale(-1, 1)`}><path d="M-8 -6 L8 2" stroke={c} strokeWidth="5" strokeLinecap="round" /></g>
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
  { name: "Task", config: { shape: "task", nose: "dot", eye: "dots", bg: 0 } },
  { name: "Notes", config: { shape: "book", nose: "dash", eye: "happy", bg: 1 } },
  { name: "Mail", config: { shape: "mail", nose: "smile", eye: "dots", bg: 3 } },
  { name: "Schedule", config: { shape: "calendar", nose: "dot", eye: "dots", bg: 4 } },
  { name: "Idea", config: { shape: "bulb", nose: "oh", eye: "rings", bg: 5 } },
  { name: "Project", config: { shape: "folder", nose: "dash", eye: "lines", bg: 7 } },
  { name: "Goal", config: { shape: "mountain", nose: "caret", eye: "arches", bg: 8 } },
  { name: "Dream", config: { shape: "circle", nose: "smile", eye: "shy", bg: 11 } },
  { name: "Organize", config: { shape: "rounded", nose: "dot", eye: "sleepy", bg: 6 } },
  { name: "Explore", config: { shape: "hexagon", nose: "hookL", eye: "wink", bg: 9 } },
  { name: "Focus", config: { shape: "task", nose: "caret", eye: "lines", bg: 2 } },
  { name: "Collect", config: { shape: "book", nose: "oh", eye: "rings", bg: 10 } },
  { name: "Chat", config: { shape: "chat", nose: "grin", eye: "surprised", bg: 12 } },
  { name: "Guard", config: { shape: "shield", nose: "smirk", eye: "glasses", bg: 18 } },
  { name: "Adore", config: { shape: "heart", nose: "pucker", eye: "heart", bg: 15 } },
  { name: "Shine", config: { shape: "star", nose: "gasp", eye: "sparkle", bg: 16 } },
  { name: "Energy", config: { shape: "bolt", nose: "zigzag", eye: "big", bg: 5 } },
  { name: "Milestone", config: { shape: "flag", nose: "smile", eye: "happy", bg: 26 } },
  { name: "Growth", config: { shape: "leaf", nose: "dot", eye: "sleepy", bg: 22 } },
  { name: "Flow", config: { shape: "drop", nose: "oh", eye: "shy", bg: 20 } },
  { name: "Champion", config: { shape: "trophy", nose: "grin", eye: "puppy", bg: 16 } },
  { name: "Royalty", config: { shape: "crown", nose: "smirk", eye: "target", bg: 21 } },
  { name: "Launch", config: { shape: "rocket", nose: "gasp", eye: "cross", bg: 8 } },
  { name: "Night", config: { shape: "moon", nose: "dash", eye: "square", bg: 14 } },
  { name: "Sharp", config: { shape: "triangle", nose: "zigzag", eye: "angry", bg: 25 } },
  { name: "Precious", config: { shape: "gem", nose: "oh", eye: "sparkle", bg: 17 } },
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

// ─────────────────────────────────────────────────────────────
// PHOTO AVATAR DETECTION — same leading-`/`/`https://`/`http://` check as
// community `avatar.tsx`'s private `isUrl`, duplicated intentionally rather
// than cross-imported: `components/avatar/` is the generic module,
// `components/community/avatar.tsx` is community-specific, and the reverse
// import would invert that layering.
// ─────────────────────────────────────────────────────────────
export function isPhotoAvatarUrl(url: string | null | undefined): boolean {
  return !!url && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/"));
}

// ─────────────────────────────────────────────────────────────
// AVATAR DRAFT — the dual-mode draft used by `BotAvatarPickerDialog`.
// `file` is null when re-opening an *existing* photo untouched (edit); a
// real `File` once freshly cropped this session.
// ─────────────────────────────────────────────────────────────
export type AvatarDraft =
  | { kind: "procedural"; image: string }
  | { kind: "photo"; file: File | null; previewUrl: string };

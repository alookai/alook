import type { CSSProperties } from "react"

/* The brand's retro objects (brand-visual, Gus-approved): a Mac, a CD player,
 * a cassette and a flip phone, drawn with the ink outline. One source for the
 * brand board and the landing page. */

const INK = "#1f1a15"

export function Mac({ className, style, label = "hello", labelFont = "var(--font-caveat), cursive" }: { className?: string; style?: CSSProperties; label?: string; labelFont?: string }) {
  return (
    <svg viewBox="0 0 272 280" className={className} style={style} aria-hidden>
      <g stroke={INK} strokeWidth="3.5" strokeLinejoin="round">
        <path d="M58 14h150a14 14 0 0 1 14 14v158H44V28a14 14 0 0 1 14-14z" fill="#d0c0a5" />
        <path d="M222 28l22 10v156l-22-8z" fill="#b9a67e" />
        <path d="M44 186h178l22 8H66z" fill="#b9a67e" />
        <rect x="70" y="34" width="126" height="92" rx="10" fill="#1f1a15" />
        <rect x="78" y="42" width="110" height="76" rx="6" fill="#d8e7ea" />
        <path d="M150 154h46" strokeLinecap="round" />
        <rect x="64" y="148" width="18" height="12" rx="2" fill="#e3d8c4" strokeWidth="2.5" />
        {/* Keyboard centred under the Mac body (front 44–222 plus its side). */}
        <g transform="translate(14 0)">
          <path d="M20 210h200l26 50H6z" fill="#d0c0a5" />
          <path d="M6 260h240v8H6z" fill="#b9a67e" />
          <g fill="#5d4f35" strokeWidth="2">
            <rect x="40" y="218" width="160" height="10" rx="2" />
            <rect x="34" y="232" width="174" height="10" rx="2" />
            <rect x="28" y="246" width="186" height="8" rx="2" />
          </g>
        </g>
      </g>
      <path d="M86 48l14 0M86 56l8 0" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity=".8" />
      <text x="133" y="92" textAnchor="middle" fontFamily={labelFont} fontSize="40" fontWeight="700" fill={INK}>{label}</text>
    </svg>
  )
}

export function CdPlayer({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 200 170" className={className} style={style} aria-hidden>
      <g stroke={INK} strokeWidth="3.5" strokeLinejoin="round">
        <ellipse cx="100" cy="96" rx="92" ry="66" fill="#34588f" />
        <ellipse cx="100" cy="86" rx="92" ry="66" fill="#5f8bcf" />
        <path d="M70 30h60l-10 54H80z" fill="#e6e5e0" />
        <rect x="84" y="40" width="32" height="16" rx="3" fill="#b7d5b9" strokeWidth="2.5" />
        <g fill="#e6e5e0" strokeWidth="2.5"><circle cx="58" cy="112" r="6" /><circle cx="78" cy="118" r="6" /><circle cx="142" cy="112" r="6" /><circle cx="122" cy="118" r="6" /><circle cx="100" cy="122" r="11" /></g>
      </g>
      <path d="M40 60c14-18 34-28 52-30" stroke="#fff" strokeWidth="5" strokeLinecap="round" fill="none" opacity=".55" />
    </svg>
  )
}

export function Cassette({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 180 120" className={className} style={style} aria-hidden>
      <g stroke={INK} strokeWidth="3.5" strokeLinejoin="round">
        <rect x="6" y="10" width="168" height="104" rx="10" fill="#c9dbe0" />
        <rect x="6" y="6" width="168" height="104" rx="10" fill="#e2edeb" />
        <rect x="26" y="22" width="128" height="44" rx="6" fill="#fffdf8" />
        <circle cx="58" cy="44" r="15" fill="#1f1a15" /><circle cx="122" cy="44" r="15" fill="#1f1a15" />
        <circle cx="58" cy="44" r="6" fill="#e2edeb" strokeWidth="2.5" /><circle cx="122" cy="44" r="6" fill="#e2edeb" strokeWidth="2.5" />
        <path d="M40 110l10-26h80l10 26" fill="#d0c0a5" />
      </g>
      <path d="M28 76h40" stroke="#e38b32" strokeWidth="5" strokeLinecap="round" />
    </svg>
  )
}

export function FlipPhone({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 90 170" className={className} style={style} aria-hidden>
      <g stroke={INK} strokeWidth="3.5" strokeLinejoin="round">
        <rect x="8" y="4" width="74" height="74" rx="18" fill="#c7c9cc" />
        <rect x="20" y="14" width="50" height="46" rx="6" fill="#d8e7ea" />
        <rect x="8" y="84" width="74" height="82" rx="18" fill="#b3b6ba" />
        <g fill="#e6e5e0" strokeWidth="2.5"><rect x="20" y="98" width="14" height="9" rx="4" /><rect x="38" y="98" width="14" height="9" rx="4" /><rect x="56" y="98" width="14" height="9" rx="4" /><rect x="20" y="114" width="14" height="9" rx="4" /><rect x="38" y="114" width="14" height="9" rx="4" /><rect x="56" y="114" width="14" height="9" rx="4" /><rect x="20" y="130" width="14" height="9" rx="4" /><rect x="38" y="130" width="14" height="9" rx="4" /><rect x="56" y="130" width="14" height="9" rx="4" /></g>
      </g>
      <path d="M45 26c-8 6-8 18 0 24 8-6 8-18 0-24z" fill="#e38b32" stroke={INK} strokeWidth="2" />
    </svg>
  )
}

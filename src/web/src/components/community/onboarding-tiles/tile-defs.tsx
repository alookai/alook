// Shared SVG assets for the onboarding motion tiles (Connect / Create / Memory /
// Workspace / Nap). Defined once and referenced by <use> inside each tile's SVG.
// Real Alook assets: lucide icon paths (exact, from lucide-react@1.25.0), the app's
// alook logo mark, beam faces from renderFaceSvg, and the circular avatar disc clip.
//
// IMPORTANT: <use href="#id"> resolves against ids that must be unique in the
// document. Each tile mounts its own copy of <TileDefs> with an `idPrefix` so
// several tiles can coexist on one page (the gallery shows three at once) without
// id collisions. The tile passes the same prefix to its <use href> refs.

export function tileIds(p: string) {
  return {
    disc: `${p}-disc`,
    monitor: `${p}-ic-monitor`,
    file: `${p}-ic-file`,
    moon: `${p}-ic-moon`,
    book: `${p}-ic-book`,
    layers: `${p}-ic-layers`,
    clock: `${p}-ic-clock`,
    alook: `${p}-ic-alook`,
    phone: `${p}-ic-phone`,
    faceA: `${p}-face-a`,
    faceB: `${p}-face-b`,
  }
}

export function TileDefs({ idPrefix }: { idPrefix: string }) {
  const id = tileIds(idPrefix)
  return (
    <defs>
      {/* circular avatar crop (the app shows beam faces clipped to a disc) */}
      <clipPath id={id.disc} clipPathUnits="userSpaceOnUse">
        <circle cx="18" cy="18" r="18" />
      </clipPath>

      {/* lucide icons — 24×24, exact path data from lucide-react@1.25.0 */}
      <g id={id.monitor}>
        <rect className="ot-art" width="20" height="14" x="2" y="3" rx="2" />
        <line className="ot-art" x1="8" x2="16" y1="21" y2="21" />
        <line className="ot-art" x1="12" x2="12" y1="17" y2="21" />
      </g>
      <g id={id.file}>
        <path className="ot-art" d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
        <path className="ot-art" d="M14 2v5a1 1 0 0 0 1 1h5" />
        <path className="ot-art" d="M10 9H8" />
        <path className="ot-art" d="M16 13H8" />
        <path className="ot-art" d="M16 17H8" />
      </g>
      <g id={id.moon}>
        <path className="ot-art" d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
      </g>
      <g id={id.phone}>
        <rect className="ot-art" width="14" height="20" x="5" y="2" rx="2" ry="2" />
        <path className="ot-art" d="M12 18h.01" />
      </g>
      {/* memory sources: memory.md=book-marked, experiences=layers, timeline=clock */}
      <g id={id.book}>
        <path className="ot-art" d="M10 2v8l3-3 3 3V2" />
        <path className="ot-art" d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
      </g>
      <g id={id.layers}>
        <path className="ot-art" d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
        <path className="ot-art" d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
        <path className="ot-art" d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
      </g>
      <g id={id.clock}>
        <circle className="ot-art" cx="12" cy="12" r="10" />
        <path className="ot-art" d="M12 6v6l4 2" />
      </g>

      {/* Alook logo mark (public/alook.svg) — nested-svg viewBox 3 5 22 22 */}
      <g id={id.alook}>
        <rect x="4" y="6" width="18" height="18" rx="3" fill="currentColor" opacity="0.4" />
        <rect x="6" y="8" width="18" height="18" rx="3" fill="currentColor" />
        <rect x="9.5" y="13" width="11" height="9" rx="2" fill="var(--card)" />
        <path d="M 10 13.5 Q 15 18.5 20 13.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </g>

      {/* Real beam faces (renderFaceSvg). faceA = existing agent, faceB = new bot. */}
      <g id={id.faceA}>
        <rect width="36" height="36" fill="#2a5540" />
        <g transform="translate(1.38 0.40) rotate(-4 18 23.5) translate(-0.18 -0.24) scale(1.010)">
          <path d="M32.45 23.50 L32.42 24.41 L32.34 25.31 L32.19 26.21 L32.00 27.09 L31.74 27.97 L31.44 28.82 L31.07 29.65 L30.66 30.46 L30.20 31.24 L29.69 31.99 L29.13 32.71 L28.53 33.39 L27.89 34.03 L27.21 34.63 L26.49 35.19 L25.74 35.70 L24.96 36.16 L24.15 36.57 L23.32 36.94 L22.47 37.24 L21.59 37.50 L20.71 37.69 L19.81 37.84 L18.91 37.92 L18.00 37.95 L17.09 37.92 L16.19 37.84 L15.29 37.69 L14.41 37.50 L13.53 37.24 L12.68 36.94 L11.85 36.57 L11.04 36.16 L10.26 35.70 L9.51 35.19 L8.79 34.63 L8.11 34.03 L7.47 33.39 L6.87 32.71 L6.31 31.99 L5.80 31.24 L5.34 30.46 L4.93 29.65 L4.56 28.82 L4.26 27.97 L4.00 27.09 L3.81 26.21 L3.66 25.31 L3.58 24.41 L3.55 23.50 L3.58 22.59 L3.66 21.69 L3.81 20.79 L4.00 19.91 L4.26 19.03 L4.56 18.18 L4.93 17.35 L5.34 16.54 L5.80 15.76 L6.31 15.01 L6.87 14.29 L7.47 13.61 L8.11 12.97 L8.79 12.37 L9.51 11.81 L10.26 11.30 L11.04 10.84 L11.85 10.43 L12.68 10.06 L13.53 9.76 L14.41 9.50 L15.29 9.31 L16.19 9.16 L17.09 9.08 L18.00 9.05 L18.91 9.08 L19.81 9.16 L20.71 9.31 L21.59 9.50 L22.47 9.76 L23.32 10.06 L24.15 10.43 L24.96 10.84 L25.74 11.30 L26.49 11.81 L27.21 12.37 L27.89 12.97 L28.53 13.61 L29.13 14.29 L29.69 15.01 L30.20 15.76 L30.66 16.54 L31.07 17.35 L31.44 18.18 L31.74 19.03 L32.00 19.91 L32.19 20.79 L32.34 21.69 L32.42 22.59 L32.45 23.50 Z" fill="#e7f3ec" />
          <path d="M12.2 20.7 q1.8 -2 3.6 0" stroke="#12241b" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M20.2 20.7 q1.8 -2 3.6 0" stroke="#12241b" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M14.5 24q3.5 2.6 7 0" stroke="#12241b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </g>
      </g>
      <g id={id.faceB}>
        <rect width="36" height="36" fill="#2a5540" />
        <g transform="translate(-0.46 0.40) rotate(-3 18 23.5) translate(-0.18 -0.24) scale(1.010)">
          <path d="M31.53 23.50 L31.44 24.35 L31.18 25.16 L30.76 25.93 L30.22 26.64 L29.57 27.26 L28.86 27.80 L28.13 28.27 L27.40 28.67 L26.70 29.02 L26.07 29.36 L25.50 29.70 L25.01 30.08 L24.58 30.51 L24.20 31.00 L23.86 31.57 L23.52 32.20 L23.17 32.90 L22.77 33.63 L22.30 34.36 L21.76 35.07 L21.14 35.72 L20.43 36.26 L19.66 36.68 L18.85 36.94 L18.00 37.03 L17.15 36.94 L16.34 36.68 L15.57 36.26 L14.86 35.72 L14.24 35.07 L13.70 34.36 L13.23 33.63 L12.83 32.90 L12.48 32.20 L12.14 31.57 L11.80 31.00 L11.42 30.51 L10.99 30.08 L10.50 29.70 L9.93 29.36 L9.30 29.02 L8.60 28.67 L7.87 28.27 L7.14 27.80 L6.43 27.26 L5.78 26.64 L5.24 25.93 L4.82 25.16 L4.56 24.35 L4.47 23.50 L4.56 22.65 L4.82 21.84 L5.24 21.07 L5.78 20.36 L6.43 19.74 L7.14 19.20 L7.87 18.73 L8.60 18.33 L9.30 17.98 L9.93 17.64 L10.50 17.30 L10.99 16.92 L11.42 16.49 L11.80 16.00 L12.14 15.43 L12.48 14.80 L12.83 14.10 L13.23 13.37 L13.70 12.64 L14.24 11.93 L14.86 11.28 L15.57 10.74 L16.34 10.32 L17.15 10.06 L18.00 9.97 L18.85 10.06 L19.66 10.32 L20.43 10.74 L21.14 11.28 L21.76 11.93 L22.30 12.64 L22.77 13.37 L23.17 14.10 L23.52 14.80 L23.86 15.43 L24.20 16.00 L24.58 16.49 L25.01 16.92 L25.50 17.30 L26.07 17.64 L26.70 17.98 L27.40 18.33 L28.13 18.73 L28.86 19.20 L29.57 19.74 L30.22 20.36 L30.76 21.07 L31.18 21.84 L31.44 22.65 L31.53 23.50 Z" fill="#e7f3ec" />
          <circle cx="13" cy="20" r="1.9" fill="#12241b" />
          <path d="M21.2 20 q1.8 1.7 3.6 0" stroke="#12241b" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M14.5 25q3.5 2.6 7 0" stroke="#12241b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </g>
      </g>
    </defs>
  )
}

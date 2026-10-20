// Theme handling.
//
// The stylesheet defines both palettes and switches on `prefers-color-scheme`,
// so the correct theme is already applied before this module runs. All we add
// is a manual override, remembered when storage is available. `file://` pages
// can throw on localStorage access in some browsers, hence the try/catch.

const KEY = 'twv.theme';
const MODES = ['auto', 'light', 'dark'];

function readStored() {
  try {
    const v = localStorage.getItem(KEY);
    return MODES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function writeStored(mode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage unavailable (private mode, file://) — the override is session-only */
  }
}

let mode = 'auto';

export function currentMode() {
  return mode;
}

/** True when the page is currently painted dark, whichever way we got there. */
export function isDark() {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function applyTheme(next) {
  mode = MODES.includes(next) ? next : 'auto';
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  writeStored(mode);
  document.dispatchEvent(new CustomEvent('twv:themechange', { detail: { mode } }));
  return mode;
}

export function cycleTheme() {
  return applyTheme(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
}

export function initTheme() {
  applyTheme(readStored());
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (mode === 'auto') {
        document.dispatchEvent(new CustomEvent('twv:themechange', { detail: { mode } }));
      }
    });
  }
  return mode;
}

/**
 * Deterministic per-service colours. Hue is derived from the service name so a
 * service keeps its colour across reloads and across exported images.
 */
export function serviceColor(service, index) {
  const hue = (hash(service) + index * 47) % 360;
  return {
    bar: `hsl(${hue} 62% 52%)`,
    barDark: `hsl(${hue} 55% 58%)`,
    dot: `hsl(${hue} 62% 46%)`,
    dotDark: `hsl(${hue} 60% 62%)`,
  };
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

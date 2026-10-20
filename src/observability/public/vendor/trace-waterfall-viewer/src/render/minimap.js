// Minimap: the whole trace at a glance, plus the current zoom window.
//
// Every span is drawn as a hairline segment, vertically positioned by its row
// index, so the shape of the trace stays recognisable even at 10k spans. Drag
// inside the window to pan, drag outside it to brush a new window.

export function createMinimap(canvas, handlers = {}) {
  const ctx = canvas.getContext('2d');
  let state = null;
  let drag = null;

  function setState(next) {
    state = next;
    draw();
  }

  function draw() {
    if (!state) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 48;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { rows, colors, view, trace, showCritical, cp } = state;
    const total = trace.duration || 1;
    const n = Math.max(rows.length, 1);
    const rowH = Math.max(height / n, 0.6);

    for (let i = 0; i < rows.length; i++) {
      const span = rows[i];
      const x = (span.start / total) * width;
      const w = Math.max((span.duration / total) * width, 0.75);
      const y = (i / n) * height;
      ctx.globalAlpha =
        showCritical && !cp.uids.has(span.uid) ? 0.28 : span.statusCode === 'error' ? 1 : 0.85;
      ctx.fillStyle = span.statusCode === 'error' ? '#e5484d' : colors.get(span.service);
      ctx.fillRect(x, y, w, Math.max(rowH - 0.4, 0.8));
    }
    ctx.globalAlpha = 1;

    // Zoom window.
    const x0 = (view.start / total) * width;
    const x1 = (view.end / total) * width;
    ctx.fillStyle = state.dim;
    ctx.fillRect(0, 0, Math.max(x0, 0), height);
    ctx.fillRect(Math.min(x1, width), 0, width - x1, height);
    ctx.strokeStyle = state.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(Math.round(x1 - x0) - 1, 1), height - 1);
  }

  function timeAt(clientX) {
    const rect = canvas.getBoundingClientRect();
    const pct = (clientX - rect.left) / (rect.width || 1);
    return Math.min(Math.max(pct, 0), 1) * (state.trace.duration || 1);
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!state) return;
    canvas.setPointerCapture(event.pointerId);
    const t = timeAt(event.clientX);
    const inside = t >= state.view.start && t <= state.view.end;
    drag = inside
      ? { mode: 'pan', origin: t, start: state.view.start, end: state.view.end }
      : { mode: 'brush', origin: t, moved: false };
    if (drag.mode === 'brush') emitBrush(t, t);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drag || !state) return;
    const t = timeAt(event.clientX);
    if (drag.mode === 'pan') {
      const shift = t - drag.origin;
      emit(drag.start + shift, drag.end + shift);
    } else {
      drag.moved = true;
      emitBrush(drag.origin, t);
    }
  });

  function end(event) {
    if (!drag) return;
    if (drag.mode === 'brush' && !drag.moved && handlers.onCenter) {
      handlers.onCenter(drag.origin);
    }
    drag = null;
    if (event && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  function emit(start, end_) {
    if (handlers.onViewChange) handlers.onViewChange(start, end_);
  }
  function emitBrush(a, b) {
    const start = Math.min(a, b);
    const stop = Math.max(a, b);
    if (stop - start < (state.trace.duration || 1) / 2000) return;
    emit(start, stop);
  }

  return { setState, redraw: draw };
}

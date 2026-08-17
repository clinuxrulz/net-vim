import { onMount, createEffect, onCleanup } from 'solid-js';
import { measureFont, decodeChar, type GridRendererProps } from './font-metrics';

const STYLE_ID = 'net-vim-dom-renderer-styles';
let styleRefCount = 0;

type RowState = {
  charsBuf: Uint8Array;
  fgsBuf: Uint8Array;
  bgsBuf: Uint8Array;
  spans: HTMLSpanElement[];
};

type Run = { text: string; fg: string; bg: string };

function rgbToHex(fgs: Uint8Array, offset: number): string {
  const r = fgs[offset];
  const g = fgs[offset + 1];
  const b = fgs[offset + 2];
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function buildRuns(chars: Uint8Array, fgs: Uint8Array, bgs: Uint8Array, width: number, y: number): Run[] {
  const runs: Run[] = [];
  let runText = '';
  let runFg = '';
  let runBg = '';
  const flush = () => {
    if (runText) {
      runs.push({ text: runText, fg: runFg, bg: runBg });
      runText = '';
      runFg = '';
      runBg = '';
    }
  };

  for (let x = 0; x < width; x++) {
    const idx = y * width + x;
    const c = decodeChar(chars, idx);
    const fg = rgbToHex(fgs, idx * 3);
    const bg = rgbToHex(bgs, idx * 3);
    if (fg !== runFg || bg !== runBg) {
      flush();
      runFg = fg;
      runBg = bg;
    }
    runText += c;
  }
  flush();
  return runs;
}

export function createRowSpans(chars: Uint8Array, fgs: Uint8Array, bgs: Uint8Array, width: number, y: number): HTMLSpanElement[] {
  const runs = buildRuns(chars, fgs, bgs, width, y);
  const spans = runs.map((run) => {
    const span = document.createElement('span');
    span.textContent = run.text;
    span.style.color = run.fg;
    span.style.backgroundColor = run.bg;
    span.dataset.fg = run.fg;
    span.dataset.bg = run.bg;
    return span;
  });
  if (spans.length === 0) {
    const empty = document.createElement('span');
    empty.textContent = '';
    spans.push(empty);
  }
  return spans;
}

// Pre-allocated color runs per row. Typical rows need 1-3; the pool is
// fixed so scrolling never adds/removes nodes (which would interrupt an
// active touch gesture). Unused pool spans hold empty text.
const MAX_RUNS = 8;

function ensureRowSpans(row: HTMLDivElement): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = [];
  for (let i = 0; i < MAX_RUNS; i++) {
    const span = document.createElement('span');
    row.appendChild(span);
    spans.push(span);
  }
  return spans;
}

/**
 * Paint a row's runs into its pre-allocated span pool. Only textContent and
 * colors are rewritten — the node structure stays identical, so a finger
 * touching a row never has its element destroyed mid-gesture, and each frame
 * costs a handful of cheap property writes.
 */
function applyRowContent(prev: HTMLSpanElement[], runs: Run[]): void {
  for (let i = 0; i < MAX_RUNS; i++) {
    const span = prev[i];
    const run = runs[i];
    if (run) {
      if (span.dataset.fg !== run.fg || span.dataset.bg !== run.bg) {
        span.style.color = run.fg;
        span.style.backgroundColor = run.bg;
        span.dataset.fg = run.fg;
        span.dataset.bg = run.bg;
      }
      if (span.textContent !== run.text) {
        span.textContent = run.text;
      }
    } else if (span.textContent) {
      span.textContent = '';
    }
  }
}

function rowsEqual(state: RowState, chars: Uint8Array, fgs: Uint8Array, bgs: Uint8Array, width: number, y: number): boolean {
  if (state.charsBuf.length !== width) return false;
  const rowOff = y * width;
  for (let i = 0; i < width; i++) {
    if (state.charsBuf[i] !== chars[rowOff + i]) return false;
  }
  const off = y * width * 3;
  for (let i = 0; i < width * 3; i++) {
    if (state.fgsBuf[i] !== fgs[off + i]) return false;
    if (state.bgsBuf[i] !== bgs[off + i]) return false;
  }
  return true;
}

const BASE_FONT_SIZE = 24;

export const DOMRenderer = (props: GridRendererProps) => {
  let containerRef: HTMLDivElement | undefined;
  let cursorRef: HTMLDivElement | undefined;
  const base = measureFont();
  const baseZoom = base.cellWidth;

  const cellWidth = () => props.cellWidth ?? base.cellWidth;
  const cellHeight = () => props.cellHeight ?? base.cellHeight;
  const zoom = () => cellWidth() / baseZoom;
  const fontSize = () => BASE_FONT_SIZE * zoom();
  const letterSpacing = () => Math.max(0, cellWidth() - base.advance * zoom());

  const rowCache: Array<RowState | null> = [];
  let lastFlexHeight = -1;

  const syncRows = () => {
    if (!containerRef) return;
    const { width, height, chars, fgs, bgs } = props;

    // Ignore until a frame sized to the current grid arrives. Signal updates
    // (gridDim vs renderData) can be observed in partial batches during resizes,
    // so diffing against mismatched arrays would corrupt the rows.
    const expected = width * height;
    if (chars.length !== expected || fgs.length !== expected * 3 || bgs.length !== expected * 3) {
      return;
    }

    const cursorAttached = cursorRef && containerRef.contains(cursorRef);
    const hasCursor = cursorAttached ? 1 : 0;
    let rowCount = containerRef.children.length - hasCursor;

    while (rowCount > height) {
      containerRef.removeChild(containerRef.children[rowCount - 1]);
      rowCache.pop();
      rowCount--;
    }
    while (rowCount < height) {
      const row = document.createElement('div');
      row.className = 'nv-row';
      // Insert BEFORE the cursor (if present) so rows always stay ahead of it
      const anchor = cursorRef && containerRef.contains(cursorRef) ? cursorRef : null;
      containerRef.insertBefore(row, anchor);
      rowCache.push({ charsBuf: new Uint8Array(0), fgsBuf: new Uint8Array(0), bgsBuf: new Uint8Array(0), spans: ensureRowSpans(row) });
      rowCount++;
    }

    for (let y = 0; y < height; y++) {
      const state = rowCache[y]!;
      if (state.charsBuf.length === width && rowsEqual(state, chars, fgs, bgs, width, y)) {
        continue;
      }
      const runs = buildRuns(chars, fgs, bgs, width, y);
      applyRowContent(state.spans, runs);
      state.charsBuf = chars.slice(y * width, (y + 1) * width);
      state.fgsBuf = fgs.slice(y * width * 3, (y + 1) * width * 3);
      state.bgsBuf = bgs.slice(y * width * 3, (y + 1) * width * 3);
    }
    // Stretch the last row to absorb any leftover height so the grid
    // fills the container like the WebGL renderer (which stretches its canvas).
    // Only needed when the row count changes — skip the per-frame style writes.
    if (height !== lastFlexHeight) {
      lastFlexHeight = height;
      for (let y = 0; y < height; y++) {
        const row = containerRef.children[y] as HTMLDivElement;
        row.style.flex = y === height - 1 ? '1 1 auto' : '0 0 auto';
      }
    }
    // Keep the cursor as the last element so it renders on top of rows
    if (cursorRef && containerRef.lastChild !== cursorRef && cursorRef.parentNode === containerRef) {
      containerRef.appendChild(cursorRef);
    }
  };

  const syncCursor = () => {
    if (!containerRef || !cursorRef) return;
    cursorRef.style.display = props.showCursor ? 'block' : 'none';
    cursorRef.style.left = `${props.cursorX * cellWidth()}px`;
    cursorRef.style.top = `${props.cursorY * cellHeight()}px`;
  };

  const syncZoom = () => {
    if (!containerRef) return;
    containerRef.style.setProperty('--nv-cell-w', `${cellWidth()}px`);
    containerRef.style.setProperty('--nv-cell-h', `${cellHeight()}px`);
    containerRef.style.setProperty('--nv-ls', `${letterSpacing()}px`);
    containerRef.style.setProperty('--nv-font-size', `${fontSize()}px`);
    if (cursorRef) {
      cursorRef.style.width = `${cellWidth()}px`;
      cursorRef.style.height = `${cellHeight()}px`;
    }
  };

  onMount(() => {
    ensureStyles();
    if (!containerRef) return;
    // Build rows first, then append the cursor LAST so that
    // containerRef.children[y] maps to grid row y for every y < height.
    syncRows();
    cursorRef = document.createElement('div');
    cursorRef.className = 'nv-cursor';
    cursorRef.style.display = 'none';
    containerRef.appendChild(cursorRef);
    syncZoom();
    if (props.onMeasure) {
      props.onMeasure({ width: base.cellWidth, height: base.cellHeight });
    }
    syncCursor();
    styleRefCount++;
    onCleanup(() => {
      styleRefCount--;
      if (styleRefCount <= 0) {
        document.getElementById(STYLE_ID)?.remove();
      }
    });
  });

  createEffect(syncRows);
  createEffect(syncCursor);
  createEffect(syncZoom);

  return (
    <div ref={containerRef} class={`nv-dom-grid${props.crtEnabled ? ' nv-crt nv-vignette' : ''}`} />
  );
};

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.nv-dom-grid {
  --nv-cell-w: 17px;
  --nv-cell-h: 32px;
  --nv-ls: 2.6px;
  --nv-font-size: 24px;
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #141414;
  font-family: monospace;
  font-weight: bold;
  font-size: var(--nv-font-size);
  line-height: var(--nv-cell-h);
  -webkit-user-select: none;
  user-select: none;
  touch-action: none;
  -webkit-touch-callout: none;
}
.nv-row {
  flex: 0 0 auto;
  height: var(--nv-cell-h);
  line-height: var(--nv-cell-h);
  white-space: pre;
  overflow: hidden;
  letter-spacing: var(--nv-ls);
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
  contain: layout style paint;
}
.nv-row *
{
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
}
.nv-cursor {
  position: absolute;
  width: var(--nv-cell-w);
  height: var(--nv-cell-h);
  pointer-events: none;
  box-sizing: border-box;
  border-bottom: 2px solid #e6e6e6;
  background: rgba(255, 255, 255, 0.12);
  z-index: 1;
  animation: nv-blink 1s steps(1) infinite;
}
@keyframes nv-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
.nv-crt::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  background: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent 2px,
    rgba(0, 0, 0, 0.25) 2px,
    rgba(0, 0, 0, 0.25) 3px
  );
}
.nv-vignette::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  background: radial-gradient(ellipse at center, transparent 65%, rgba(0, 0, 0, 0.35) 100%);
}`;
  document.head.appendChild(style);
}
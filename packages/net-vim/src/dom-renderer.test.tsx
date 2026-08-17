import { describe, it, expect, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { DOMRenderer, createRowSpans } from './DOMRenderer';
import { decodeChar } from './font-metrics';

vi.mock('./font-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./font-metrics')>();
  return {
    ...actual,
    measureFont: () => ({ cellWidth: 10, cellHeight: 20, advance: 8 }),
  };
});

function makeGrid(overrides: Partial<{ width: number; height: number }> = {}) {
  const width = overrides.width ?? 4;
  const height = overrides.height ?? 2;
  const chars = new Uint8Array(width * height);
  const fgs = new Uint8Array(width * height * 3).fill(200);
  const bgs = new Uint8Array(width * height * 3).fill(20);
  return { chars, fgs, bgs, width, height };
}

describe('decodeChar', () => {
  it('maps box-drawing codes 1-15 to their glyph', () => {
    expect(decodeChar(new Uint8Array([3]), 0)).toBe('┌');
    expect(decodeChar(new Uint8Array([15]), 0)).toBe('╰');
  });

  it('maps null cells to a space', () => {
    expect(decodeChar(new Uint8Array([0]), 0)).toBe(' ');
  });

  it('maps ASCII byte values to characters', () => {
    expect(decodeChar(new Uint8Array([65]), 0)).toBe('A');
    expect(decodeChar(new Uint8Array([126]), 0)).toBe('~');
  });
});

describe('createRowSpans', () => {
  it('groups consecutive cells sharing the same fg/bg into a single span', () => {
    const { chars, fgs, bgs, width } = makeGrid();
    chars[0] = 65; // A
    chars[1] = 66; // B
    fgs.fill(255); // all cells the same foreground
    const spans = createRowSpans(chars, fgs, bgs, width, 0);
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe('AB  ');
    expect(spans[0].style.color).toBe('rgb(255, 255, 255)');
    expect(spans[0].style.backgroundColor).toBe('rgb(20, 20, 20)');
  });

  it('splits spans when colors change', () => {
    const { chars, fgs, bgs, width } = makeGrid({ width: 3 });
    chars[0] = 65; // A (red)
    chars[1] = 66; // B (green)
    fgs[0] = 255; fgs[1] = 0; fgs[2] = 0; // red
    fgs.fill(0, 3); fgs[4] = 255; fgs[7] = 255; // green for B and the trailing space
    const spans = createRowSpans(chars, fgs, bgs, width, 0);
    expect(spans.length).toBe(2);
    expect(spans[0].textContent).toBe('A');
    expect(spans[0].style.color).toBe('rgb(255, 0, 0)');
    expect(spans[1].textContent).toBe('B ');
    expect(spans[1].style.color).toBe('rgb(0, 255, 0)');
  });
});

describe('DOMRenderer', () => {
  it('renders a row per grid row', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const grid = makeGrid({ height: 3 });
    render(() => <DOMRenderer {...grid} showCursor={false} cursorX={0} cursorY={0} />, container);
    const rows = container.querySelectorAll('.nv-row');
    expect(rows.length).toBe(3);
    expect(container.querySelector('.nv-dom-grid')).not.toBeNull();
    document.body.removeChild(container);
  });

  it('applies pinch-zoom via cellWidth/cellHeight props to css vars', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const grid = makeGrid({ height: 2 });
    render(() => <DOMRenderer {...grid} showCursor={false} cursorX={1} cursorY={1} cellWidth={34} cellHeight={64} />, container);
    const el = container.querySelector('.nv-dom-grid') as HTMLElement;
    expect(el.style.getPropertyValue('--nv-cell-w')).toBe('34px');
    expect(el.style.getPropertyValue('--nv-cell-h')).toBe('64px');
    expect(Number.parseFloat(el.style.getPropertyValue('--nv-font-size'))).toBeGreaterThan(24);
    const cursor = container.querySelector('.nv-cursor') as HTMLElement;
    expect(cursor.style.width).toBe('34px');
    expect(cursor.style.height).toBe('64px');
    document.body.removeChild(container);
  });

  it('keeps rows aligned when the grid grows after mount (keyboard toggle resize)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const width = 2;
    const [height, setHeight] = createSignal(2);
    const [chars, setChars] = createSignal<Uint8Array>(new Uint8Array([97, 98, 99, 100])); // ab / cd
    const [fgs, setFgs] = createSignal<Uint8Array>(new Uint8Array(2 * 2 * 3).fill(255));
    const [bgs, setBgs] = createSignal<Uint8Array>(new Uint8Array(2 * 2 * 3).fill(20));

    render(() => (
      <DOMRenderer
        chars={chars()}
        fgs={fgs()}
        bgs={bgs()}
        width={width}
        height={height()}
        showCursor={true}
        cursorX={0}
        cursorY={0}
      />
    ), container);

    expect(Array.from(container.querySelectorAll('.nv-row')).map(r => r.textContent)).toEqual(['ab', 'cd']);

    // Simulate keyboard collapsing (editor height grows): height 2 -> 4, new data
    setHeight(4);
    setChars(new Uint8Array([97, 98, 99, 100, 101, 102, 103, 104])); // ab cd ef gh
    setFgs(new Uint8Array(2 * 4 * 3).fill(255));
    setBgs(new Uint8Array(2 * 4 * 3).fill(20));

    expect(Array.from(container.querySelectorAll('.nv-row')).map(r => r.textContent)).toEqual(['ab', 'cd', 'ef', 'gh']);
    document.body.removeChild(container);
  });

  it('reuses span nodes in place when the run structure is unchanged (no DOM churn mid-drag)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const grid = makeGrid({ height: 2 });
    const [chars, setChars] = createSignal(grid.chars);
    const [fgs, setFgs] = createSignal(grid.fgs);
    const [bgs, setBgs] = createSignal(grid.bgs);

    render(() => (
      <DOMRenderer
        chars={chars()}
        fgs={fgs()}
        bgs={bgs()}
        width={grid.width}
        height={grid.height}
        showCursor={false}
        cursorX={0}
        cursorY={0}
      />
    ), container);

    const row = container.querySelector('.nv-row') as HTMLElement;
    const spanBefore = row.querySelector('span') as HTMLElement;

    // Scroll-like update: same fg/bg colors, only the text changes.
    const w = grid.width;
    const newChars = new Uint8Array(w * 2);
    newChars[0] = 72; newChars[1] = 105; newChars[w] = 66; newChars[w + 1] = 121; // "Hi" / "By"
    setChars(newChars);
    setFgs(new Uint8Array(w * 2 * 3).fill(200)); // same gray fg as initial grid
    setBgs(new Uint8Array(w * 2 * 3).fill(20));  // same bg

    const spanAfter = container.querySelector('.nv-row')!.querySelector('span') as HTMLElement;
    expect(spanAfter).toBe(spanBefore);
    expect(row.textContent).toBe('Hi  ');
    expect(spanAfter.textContent).toBe('Hi  ');
    document.body.removeChild(container);
  });

  it('updates rows reactively when the grid data changes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    let setChars!: (v: Uint8Array) => void;
    let setFgs!: (v: Uint8Array) => void;
    let setBgs!: (v: Uint8Array) => void;
    let setWidth!: (v: number) => void;
    const grid = makeGrid({ height: 2 });
    const [chars, setCharsSignal] = createSignal(grid.chars);
    const [fgs, setFgsSignal] = createSignal(grid.fgs);
    const [bgs, setBgsSignal] = createSignal(grid.bgs);
    const [width, setWidthSignal] = createSignal(grid.width);
    setChars = setCharsSignal;
    setFgs = setFgsSignal;
    setBgs = setBgsSignal;
    setWidth = setWidthSignal;

    render(() => (
      <DOMRenderer
        chars={chars()}
        fgs={fgs()}
        bgs={bgs()}
        width={width()}
        height={grid.height}
        showCursor={false}
        cursorX={0}
        cursorY={0}
      />
    ), container);

    const firstRow = container.querySelector('.nv-row') as HTMLElement;
    expect(firstRow.textContent).toBe('    ');

    setWidth(2);
    const newChars = new Uint8Array(2 * 2);
    newChars[0] = 72; newChars[1] = 105; // "Hi" on row 0
    setChars(newChars);
    const newFgs = new Uint8Array(2 * 2 * 3).fill(255);
    setFgs(newFgs);
    const newBgs = new Uint8Array(2 * 2 * 3).fill(20);
    setBgs(newBgs);

    const updatedRow = container.querySelector('.nv-row') as HTMLElement;
    expect(updatedRow.textContent).toBe('Hi');
    document.body.removeChild(container);
  });
});
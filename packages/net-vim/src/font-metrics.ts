export interface GridRendererProps {
  chars: Uint8Array;
  fgs: Uint8Array;
  bgs: Uint8Array;
  width: number;
  height: number;
  showCursor: boolean;
  cursorX: number;
  cursorY: number;
  crtEnabled?: boolean;
  showKeyboard?: boolean;
  /** Current cell size in px (drives pinch-zoom). Falls back to measured font metrics. */
  cellWidth?: number;
  cellHeight?: number;
  onMeasure?: (size: { width: number; height: number }) => void;
}

export const FONT_STYLE = 'bold 24px monospace';

export const BOX_CHARS: Record<number, string> = {
  1: '│',
  2: '─',
  3: '┌',
  4: '┐',
  5: '└',
  6: '┘',
  7: '├',
  8: '┤',
  9: '┬',
  10: '┴',
  11: '┼',
  12: '╭',
  13: '╮',
  14: '╯',
  15: '╰',
};

export function measureFont() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = FONT_STYLE;
  let maxWidth = 0;
  // Sweep over printable ASCII to find max width (the monospace advance)
  for (let i = 32; i < 127; i++) {
    const metrics = ctx.measureText(String.fromCharCode(i));
    if (metrics.width > maxWidth) {
      maxWidth = metrics.width;
    }
  }
  // Add small padding (e.g., 2px total, 1px on each side)
  const cellWidth = Math.ceil(maxWidth) + 2;
  const cellHeight = 32; // We'll keep a fixed height for the atlas rows
  return { cellWidth, cellHeight, advance: maxWidth };
}

export function decodeChar(chars: Uint8Array, index: number): string {
  const code = chars[index];
  if (code >= 1 && code <= 15) return BOX_CHARS[code];
  if (code === 0) return ' ';
  return String.fromCharCode(code);
}
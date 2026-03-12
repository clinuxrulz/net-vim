import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VimEngine } from './vim-engine';

// Mock loadScript to avoid network calls
vi.mock('./utils', () => ({
  loadScript: vi.fn().mockResolvedValue(undefined),
}));

// Mock opfsFS to avoid actual file system interaction
vi.mock('./opfs-util', () => ({
  opfsFS: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listDirectory: vi.fn(),
    isDirectory: vi.fn(),
  },
  PRELUDE_BASE: '/prelude',
}));

// Mock window.Babel and navigator.clipboard
globalThis.window = {
  ...globalThis.window,
  Babel: {
    transform: vi.fn(),
  },
} as any;

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn(),
  },
});

describe('VimEngine', () => {
  let engine: VimEngine;
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new VimEngine(onUpdate);
  });

  it('should initialize with correct default state', () => {
    const state = engine.getState();
    expect(state.mode).toBe('Normal');
    expect(state.cursor).toEqual({ x: 0, y: 0 });
    expect(state.buffer.length).toBeGreaterThan(0);
  });

  it('should move cursor down with j and up with k', () => {
    // Initial y=0
    engine.handleKey('j');
    expect(engine.getState().cursor.y).toBe(1);
    
    engine.handleKey('k');
    expect(engine.getState().cursor.y).toBe(0);
  });

  it('should move cursor right with l and left with h', () => {
    // Current line: 'Welcome to Net-Vim!'
    engine.handleKey('l');
    expect(engine.getState().cursor.x).toBe(1);
    
    engine.handleKey('h');
    expect(engine.getState().cursor.x).toBe(0);
  });

  it('should enter insert mode with i and return to normal mode with Escape', () => {
    engine.handleKey('i');
    expect(engine.getState().mode).toBe('Insert');
    
    engine.handleKey('Escape');
    expect(engine.getState().mode).toBe('Normal');
  });

  it('should insert text in Insert mode', () => {
    engine.handleKey('i');
    engine.handleKey('a');
    engine.handleKey('b');
    engine.handleKey('c');
    
    const state = engine.getState();
    expect(state.buffer[0]).toMatch(/^abc/);
    expect(state.cursor.x).toBe(3);
  });

  it('should enter command mode with :', () => {
    engine.handleKey(':');
    expect(engine.getState().mode).toBe('Command');
    expect(engine.getState().commandCursorX).toBe(0);
  });

  it('should support single-line editing in command mode', () => {
    engine.handleKey(':');
    engine.handleKey('w');
    engine.handleKey('q');
    expect(engine.getState().commandText).toBe('wq');
    expect(engine.getState().commandCursorX).toBe(2);

    engine.handleKey('ArrowLeft');
    expect(engine.getState().commandCursorX).toBe(1);

    engine.handleKey('!');
    expect(engine.getState().commandText).toBe('w!q');
    expect(engine.getState().commandCursorX).toBe(2);

    engine.handleKey('Backspace');
    expect(engine.getState().commandText).toBe('wq');
    expect(engine.getState().commandCursorX).toBe(1);
  });

  it('should delete character under cursor with x in Normal mode', () => {
    // buffer[0] = 'Welcome to Net-Vim!'
    // cursor at 0, 0
    engine.handleKey('x');
    expect(engine.getState().buffer[0]).toBe('elcome to Net-Vim!');
  });

  it('should yank line with yy and delete line with dd', async () => {
    const initialState = engine.getState();
    const firstLine = initialState.buffer[0];
    
    // Yank line
    engine.handleKey('y');
    engine.handleKey('y');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(firstLine + '\n');

    // Delete line
    engine.handleKey('d');
    engine.handleKey('d');
    expect(engine.getState().buffer[0]).not.toBe(firstLine);
    expect(engine.getState().buffer.length).toBe(initialState.buffer.length - 1);
  });

  it('should support visual mode selection and deletion', () => {
    // 'Welcome to Net-Vim!'
    engine.handleKey('v');
    engine.handleKey('l'); // select 'W' and 'e'
    engine.handleKey('l'); // select 'W', 'e', 'l'
    
    expect(engine.getState().mode).toBe('Visual');
    
    engine.handleKey('x');
    expect(engine.getState().mode).toBe('Normal');
    expect(engine.getState().buffer[0]).toBe('come to Net-Vim!');
  });
});

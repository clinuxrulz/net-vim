// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { TreeSitterHighlighter, type HighlightContext } from './highlight';
import type { LuaBackend } from '../backend';

const SRC_LINES = ['const x = 1;', '// a comment', 'function hi() {', '  return x + 1;', '}'];

function makeBackend(getBufferCount: () => void): LuaBackend & { fire: (ev: string) => void } {
  const handlers: Record<string, (...a: any[]) => void> = {};
  let buffer = [...SRC_LINES];
  return {
    executeCommand: () => {},
    registerCommand: () => {},
    delCommand: () => {},
    getBuffer: () => { getBufferCount(); return buffer; },
    setBuffer: (b) => { buffer = [...b]; Object.values(handlers).forEach((h) => h()); },
    getCurrentFilePath: () => '/proj/main.ts',
    getCursor: () => ({ x: 0, y: 0 }),
    setCursor: () => {},
    getMode: () => 'Normal',
    on: (ev, cb) => { handlers[ev] = cb; },
    registerKeymap: () => {},
    delKeymap: () => {},
    schedule: (cb) => setTimeout(cb, 0),
    defer: (cb, ms) => setTimeout(cb, ms),
    showMessage: () => {},
    getLeader: () => ' ',
    getKeymaps: () => [],
    getViewport: () => ({ width: 80, height: 24 }),
    feedKeys: () => {},
    fs: null,
    fire: (ev) => handlers[ev]?.(),
  };
}

class FakeParser {
  setLanguage() {}
  parse() { return { rootNode: null }; }
}

describe('TreeSitterHighlighter frame caching', () => {
  it('computes the buffer source once per frame instead of once per line', () => {
    (globalThis as any).__netvim_treesitter_module = { Parser: FakeParser };
    let getBufferCalls = 0;
    const backend = makeBackend(() => { getBufferCalls++; });
    const rendered: any[] = [];
    const ctx: HighlightContext = {
      backend,
      registerLineRenderer: (o) => { rendered.push(o); },
      rerender: () => {},
    };
    const hl = new TreeSitterHighlighter(ctx, {
      getSync: () => ({ kind: 'typescript' }),
      get: async () => null,
    } as any);

    // Start highlighting (registers the renderer + TextChanged subscription).
    hl.start(1, 'typescript');

    const renderer = rendered[0];
    const props = (line: number) => ({
      lineIndex: () => line,
      lineContent: () => SRC_LINES[line],
      leftCol: () => 0,
      viewportWidth: () => 80,
    });

    // Frame 1: render 5 lines -> source computed once (plus one buffer read to
    // build the parser). NOT once per line.
    const frame1 = (() => {
      const base = getBufferCalls;
      for (let i = 0; i < 5; i++) renderer.render(props(i));
      return getBufferCalls - base;
    })();
    expect(frame1).toBeGreaterThanOrEqual(1);
    expect(frame1).toBeLessThan(3); // 1 join + 1 parse, never 5

    // Frame 2: same lines, unchanged buffer -> no buffer reads at all.
    const before = getBufferCalls;
    for (let i = 0; i < 5; i++) renderer.render(props(i));
    expect(getBufferCalls).toBe(before);

    // Editing the buffer (TextChanged) invalidates the cache; the next frame
    // recomputes once but still not once-per-line.
    backend.setBuffer([...SRC_LINES, '// added']);
    expect(getBufferCalls).toBe(before); // invalidation itself reads nothing
    const frame3 = (() => {
      const base = getBufferCalls;
      for (let i = 0; i < 4; i++) renderer.render(props(i));
      return getBufferCalls - base;
    })();
    expect(frame3).toBeGreaterThanOrEqual(1);
    expect(frame3).toBeLessThan(3);

    delete (globalThis as any).__netvim_treesitter_module;
  });
});

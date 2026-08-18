// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { configureLuaRuntime } from '../lua-runtime';
import { PluginManager } from '../plugin-manager';
import type { FileSystem, VimAPI } from '../types';

const nodeRequire = createRequire(import.meta.url);
const glueWasm = nodeRequire.resolve('wasmoon/dist/glue.wasm');

function makeFS(): FileSystem {
  const files = new Map<string, string>();
  return {
    readFile: vi.fn(async (p: string) => files.get(p) ?? null),
    writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
    listDirectory: vi.fn(async (p: string) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const keys = Array.from(files.keys()).filter((k) => k.startsWith(prefix));
      return keys.map((k) => k.slice(prefix.length)).filter((k) => !k.includes('/'));
    }),
    isDirectory: vi.fn(async () => false),
  };
}

function makeVimAPI(fs: FileSystem): VimAPI {
  let buffer = ['one', 'two'];
  return {
    registerCommand: () => {},
    delCommand: () => {},
    registerKeymap: () => {},
    delKeymap: () => {},
    setLeader: () => {},
    showMessage: () => {},
    getBuffer: () => [...buffer],
    setBuffer: (b) => { buffer = [...b]; },
    requestFocus: () => {},
    getCursor: () => ({ x: 0, y: 0 }),
    setCursor: () => {},
    getVisualStart: () => null,
    getMode: () => 'Normal',
    getViewportWidth: () => 80,
    getViewportHeight: () => 24,
    getCurrentFilePath: () => '/f.txt',
    on: () => {},
    executeCommand: () => {},
    loadPluginFromSource: async () => true,
    loadLuaPluginFromSource: async () => true,
    loadPlugin: async () => true,
    getLoadedPlugins: () => [],
    getLoadedLuaPlugins: () => [],
    registerGutter: () => {},
    registerLineRenderer: () => {},
    showCompletions: () => {},
    hideCompletions: () => {},
    showHover: () => {},
    hideHover: () => {},
    registerContextMenuItem: () => {},
    insertText: () => {},
    rerender: () => {},
    showPicker: () => {},
    hidePicker: () => {},
    setFS: () => {},
    getFS: () => fs,
    resetFS: () => {},
    babel: null,
  };
}

describe('PluginManager Lua loading', () => {
  beforeAll(() => {
    configureLuaRuntime({ wasmUrl: glueWasm });
  });

  it('loads a Lua plugin source and shares the VM across calls', async () => {
    const fs = makeFS();
    const pm = new PluginManager(() => makeVimAPI(fs));
    const ok1 = await pm.loadLuaPluginFromSource('plug-a', `vim.g.marker = 'a'`);
    expect(ok1).toBe(true);
    const ok2 = await pm.loadLuaPluginFromSource('plug-b', `vim.g.marker = vim.g.marker .. 'b'`);
    expect(ok2).toBe(true);
    expect(pm.getLoadedLuaPlugins()).toEqual(expect.arrayContaining(['plug-a', 'plug-b']));
  });

  it('resolves require() from OPFS lua/ modules', async () => {
    const fs = makeFS();
    await fs.writeFile('.config/net-vim/lua/helper.lua', 'return { pick = function() return "picked" end }');
    const pm = new PluginManager(() => makeVimAPI(fs));
    const ok = await pm.loadLuaPluginFromSource('uses-helper', `
      local helper = require('helper')
      vim.g.result = helper.pick()
    `);
    expect(ok).toBe(true);
  });
});

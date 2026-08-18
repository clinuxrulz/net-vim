// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { configureLuaRuntime } from '../lua-runtime';
import { LuaPluginVM } from './lua-vm';
import type { LuaBackend } from './backend';

const nodeRequire = createRequire(import.meta.url);
const glueWasm = nodeRequire.resolve('wasmoon/dist/glue.wasm');

function makeBackend() {
  const keymapCallbacks: Record<string, { cb: () => void; raw: string }> = {};
  const backend: LuaBackend = {
    executeCommand: () => {},
    registerCommand: () => {},
    delCommand: () => {},
    getBuffer: () => ['line'],
    setBuffer: () => {},
    getCurrentFilePath: () => null,
    getCursor: () => ({ x: 0, y: 0 }),
    setCursor: () => {},
    getMode: () => 'Normal',
    on: () => {},
    registerKeymap: (mode, lhs, cb, meta) => {
      keymapCallbacks[`${mode}:${lhs}`] = { cb: cb as () => void, raw: meta?.raw ?? lhs };
    },
    delKeymap: () => {},
    schedule: (cb) => setTimeout(cb, 0),
    defer: (cb, ms) => setTimeout(cb, ms),
    showMessage: () => {},
    getLeader: () => ' ',
    getKeymaps: () => [],
    getViewport: () => ({ width: 80, height: 24 }),
    feedKeys: () => {},
    fs: null,
  };
  return { backend, keymapCallbacks };
}

describe('coroutine getchar through the real VM (which-key style)', () => {
  beforeAll(() => {
    configureLuaRuntime({ wasmUrl: glueWasm });
  });

  it('blocks on vim.fn.getcharstr() and collects the typed keys', async () => {
    const { backend, keymapCallbacks } = makeBackend();
    const vm = await LuaPluginVM.create(backend, () => null, {});

    await vm.run(`
      vim.keymap.set('n', '<leader>x', function()
        local a = vim.fn.getcharstr()
        local b = vim.fn.getcharstr()
        vim.g.received = a .. b
      end)
    `);

    const entry = keymapCallbacks['n: x'];
    expect(entry).toBeTruthy();
    expect(entry.raw).toBe('<leader>x');

    // Fires the keymap through the coroutine bridge. It should suspend waiting
    // for the first char.
    vm.invokeKeymapCallback(entry.cb);
    expect(vm.hasPendingChar()).toBe(true);

    expect(vm.resumeWithChar('a')).toBe(true); // still waiting for second char
    expect(vm.resumeWithChar('b')).toBe(false); // done

    const received = await vm.run('return vim.g.received');
    expect(received).toBe('ab');
    vm.close();
  });

  it('getcharstr(timeout) with a positive timeout returns "" when nothing is queued', async () => {
    const { backend } = makeBackend();
    const vm = await LuaPluginVM.create(backend, () => null, {});
    const out = await vm.run(`local c = require('vim').fn.getcharstr(1) return c == '' and 'empty' or 'has'`);
    expect(out).toBe('empty');
    vm.close();
  });

  afterAll(async () => {
    // no-op
  });
});
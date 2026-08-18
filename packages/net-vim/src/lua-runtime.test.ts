// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { configureLuaRuntime, createLuaEngine } from './lua-runtime';
import type { LuaBackend } from './lua/backend';

const nodeRequire = createRequire(import.meta.url);
const glueWasm = nodeRequire.resolve('wasmoon/dist/glue.wasm');

let log: string[] = [];

function makeBackend(overrides: Partial<LuaBackend> = {}): LuaBackend {
  return {
    executeCommand: (cmd) => { log.push(`cmd:${cmd}`); },
    registerCommand: (name, cb) => { log.push(`reg:${name}`); },
    delCommand: (name) => { log.push(`delcmd:${name}`); },
    getBuffer: () => ['line one', 'line two', 'line three'],
    setBuffer: (lines) => { log.push(`setBuffer:${lines.length}`); },
    getCurrentFilePath: () => '/tmp/hello.txt',
    getCursor: () => ({ x: 2, y: 1 }),
    setCursor: (x, y) => { log.push(`setCursor:${x},${y}`); },
    getMode: () => 'Normal',
    on: (event, cb) => { log.push(`on:${event}`); },
    registerKeymap: (mode, lhs, cb) => { log.push(`keymap:${mode}:${lhs}`); },
    delKeymap: (mode, lhs) => { log.push(`delkeymap:${mode}:${lhs}`); },
    schedule: (cb) => { setTimeout(cb, 0); },
    defer: (cb, ms) => { setTimeout(cb, ms); },
    showMessage: (msg) => { log.push(`msg:${msg}`); },
    getLeader: () => ' ',
    getKeymaps: () => [],
    getViewport: () => ({ width: 80, height: 24 }),
    feedKeys: () => {},
    fs: null,
    ...overrides,
  };
}

describe('lua-runtime (real wasmoon)', () => {
  beforeAll(() => {
    configureLuaRuntime({ wasmUrl: glueWasm });
    log = [];
  });

  it('creates an engine and evals basic Lua', async () => {
    const handle = await createLuaEngine();
    const result = await handle.engine.doString('return 6 * 7');
    expect(result).toBe(42);
    handle.close();
  });
});

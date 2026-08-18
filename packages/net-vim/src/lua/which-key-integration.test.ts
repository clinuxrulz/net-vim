// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { configureLuaRuntime } from '../lua-runtime';
import { VimEngine } from '../vim-engine';

const nodeRequire = createRequire(import.meta.url);
const glueWasm = nodeRequire.resolve('wasmoon/dist/glue.wasm');

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await tick(25);
  }
  return fn();
};

const INIT_LUA = `
local wk = require('which-key')
wk.setup({
  delay = 0,
  plugins = {
    marks = false,
    registers = false,
    spelling = { enabled = false },
  },
  spec = {
    { '<leader>', group = 'Leader' },
    { '<leader>l', '<cmd>LuaHello<CR>', desc = 'LuaHello' },
    { '<leader>f', group = 'File' },
    { '<leader>ff', function()
        vim.g.fired = vim.g.fired or {}
        table.insert(vim.g.fired, 'fuzzy-files-fired')
      end, desc = 'Fuzzy find' },
  },
})
vim.keymap.set('n', '<leader>x', function()
  vim.g.fired = vim.g.fired or {}
  table.insert(vim.g.fired, 'xkey')
end, { desc = 'plain keymap' })
`;

async function makeEditor() {
  const engine = new VimEngine(() => {}, () => {});
  const ok = await engine.loadLuaPluginFromSource('init.lua', INIT_LUA);
  expect(ok).toBe(true);
  // Wait until which-key's trigger keymaps have been attached. To make this
  // deterministic regardless of event-loop timing, best-effort kick which-key's
  // mode build (`config.load` is scheduled asynchronously by setup(), so this
  // may fail until it has finished — hence the retry loop).
  const hasTrigger = await waitFor(() => {
    const kms = engine.getAPI().getKeymaps?.().some((k) => k.lhs === ' ');
    if (!kms) {
      engine.evalLua(`require('which-key.buf').get({ mode = 'n', update = true })`).catch(() => {});
    }
    return kms ?? false;
  });
  expect(hasTrigger).toBe(true);
  return engine;
}

describe('which-key.nvim integration (real vendored plugin)', () => {
  beforeAll(() => {
    configureLuaRuntime({ wasmUrl: glueWasm });
  });

  it('opens the popup on <leader>, drills into groups, and executes leaves', async () => {
    const engine = await makeEditor();
    const api: any = engine.getAPI();

    // <leader> (space) opens the root popup and which-key blocks on getchar
    engine.handleKey(' ');
    expect(await waitFor(() => api.hasPendingLuaChar())).toBe(true);
    await tick(80); // let which-key's show timer render the popup
    expect(engine.getState().floatWindows.length).toBeGreaterThan(0);

    // type 'f' -> drill into the File group
    engine.handleKey('f');
    await tick(40);
    expect(api.hasPendingLuaChar()).toBe(true);

    // type 'f' -> leaf executed via nvim_feedkeys -> the <leader>ff mapping
    engine.handleKey('f');
    await tick(50);
    expect(api.hasPendingLuaChar()).toBe(false);
    expect(engine.getState().floatWindows.length).toBe(0); // popup closed

    const fired = await engine.evalLua(`return vim.inspect(vim.g.fired)`);
    expect(String(fired)).toContain('fuzzy-files-fired');
  });

  it('executes plain vim.keymap.set leaves through which-key', async () => {
    const engine = await makeEditor();
    const api: any = engine.getAPI();

    engine.handleKey(' ');
    expect(await waitFor(() => api.hasPendingLuaChar())).toBe(true);

    // '<leader>x' is a plain (non-spec) keymap; which-key still resolves it
    engine.handleKey('x');
    await tick(60);

    const fired = await engine.evalLua(`return vim.inspect(vim.g.fired)`);
    expect(String(fired)).toContain('xkey');
  });

  it('closes the popup with <Esc> without firing a mapping', async () => {
    const engine = await makeEditor();
    const api: any = engine.getAPI();

    engine.handleKey(' ');
    expect(await waitFor(() => api.hasPendingLuaChar())).toBe(true);

    engine.handleKey('Escape');
    await tick(40);
    expect(api.hasPendingLuaChar()).toBe(false);
    expect(engine.getState().floatWindows.length).toBe(0);

    const fired = await engine.evalLua(`return vim.g.fired == nil and 'none' or 'some'`);
    expect(fired).toBe('none');
  });
});

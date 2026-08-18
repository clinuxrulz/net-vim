// @vitest-environment node
//
// Conformance test: emulate the API usage patterns of real, pure-Lua Neovim
// plugins (no libuv / treesitter / native modules) running on the net-vim
// Lua shim. The snippets below mirror the style of plugins such as
// bufdelete.nvim, comment.nvim, dressing.nvim's util, and hop.nvim.
//
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { configureLuaRuntime } from '../lua-runtime';
import { LuaPluginVM } from './lua-vm';
import type { LuaBackend } from './backend';

const nodeRequire = createRequire(import.meta.url);
configureLuaRuntime({ wasmUrl: nodeRequire.resolve('wasmoon/dist/glue.wasm') });

let buffer = ['function foo() end', 'return foo()', 'third line'];
const log: string[] = [];
const keymaps: Array<[string, string]> = [];
const eventHandlers: Record<string, (...a: any[]) => void> = {};
const commands = new Map<string, (args: string[]) => void>();

const backend: LuaBackend & { runCommand: (name: string, args: string[]) => void } = {
  executeCommand: (cmd) => log.push(`cmd:${cmd}`),
  registerCommand: (name, cb) => { commands.set(name, cb); log.push(`reg:${name}`); },
  delCommand: (name) => { commands.delete(name); },
  getBuffer: () => buffer,
  setBuffer: (b) => { buffer = b; log.push('setBuffer'); },
  getCurrentFilePath: () => '/proj/src/main.lua',
  getCursor: () => ({ x: 4, y: 1 }),
  setCursor: (x, y) => log.push(`cursor:${x}:${y}`),
  getMode: () => 'Normal',
  on: (ev, cb) => { eventHandlers[ev] = cb; },
  registerKeymap: (m, lhs) => { keymaps.push([m, lhs]); },
  delKeymap: (m, lhs) => { keymaps.splice(keymaps.findIndex(([a, b]) => a === m && b === lhs), 1); },
  schedule: (cb) => setTimeout(cb, 0),
  defer: (cb) => setTimeout(cb, 0),
  showMessage: (m) => log.push(`msg:${m}`),
  fs: null,
  runCommand: (name, args) => commands.get(name)!(args),
};

let vm: LuaPluginVM;

beforeAll(async () => {
  vm = await LuaPluginVM.create(backend, () => null);
});

afterAll(() => vm.close());

describe('conformance: real plugin patterns', () => {
  it('bufdelete.nvim-style plugin (autocmd + keymap + user command)', async () => {
    const ok = await vm.runPlugin('bufdelete', `
      local M = {}
      M.opts = { keymap = '<leader>bd' }
      function M.setup(opts)
        M.opts = vim.tbl_deep_extend('force', M.opts, opts or {})
        vim.keymap.set('n', M.opts.keymap, function() M.bdelete() end)
        vim.api.nvim_create_user_command('Bdelete', function(opts) M.bdelete(opts) end, {})
        vim.api.nvim_create_autocmd('BufWritePost', { pattern = '*.lua', callback = function() vim.g.bufsaved = true end })
      end
      function M.bdelete(opts)
        local bufname = vim.fn.expand('%')
        return 'bdeleted:' .. bufname
      end
      return M
    `);
    expect(ok).toBe(true);
    expect(keymaps).toContainEqual(['n', 'leaderbd']);
    expect(log).toContain('reg:Bdelete');
    expect(eventHandlers['FileChanged']).toBeTypeOf('function');
    const result = await vm.run(`return require('bufdelete').bdelete()`);
    expect(result).toBe('bdeleted:/proj/src/main.lua');
    eventHandlers['FileChanged']?.({ path: '/proj/src/x.lua' });
    const saved = await vm.run(`return tostring(vim.g.bufsaved)`);
    expect(saved).toBe('true');
  });

  it('comment.nvim-style plugin (vim.fn.type + table ops + augroup)', async () => {
    const ok = await vm.runPlugin('comment', `
      local M = {}
      local ug = vim.api.nvim_create_augroup('comment', { clear = true })
      function M.setup()
        vim.api.nvim_create_user_command('CommentToggle', function() M.toggle() end, {})
      end
      function M.toggle()
        local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
        local out = {}
        for i, line in ipairs(lines) do
          table.insert(out, '-- ' .. line)
        end
        vim.api.nvim_buf_set_lines(0, 0, -1, false, out)
        vim.g.comments_added = vim.fn.len(lines)
      end
      return M
    `);
    expect(ok).toBe(true);
    backend.runCommand('CommentToggle', []);
    expect(buffer[0]).toBe('-- function foo() end');
    expect(buffer[1]).toBe('-- return foo()');
    expect(await vm.run('return vim.g.comments_added')).toBe(3);
  });

  it('vim.wait + vim.schedule patterns used by async plugins', async () => {
    const ok = await vm.run(`
      done = false
      local ok, why = vim.wait(20, function() return false end)
      vim.defer_fn(function() done = true end, 1)
      return tostring(ok) .. ':' .. why
    `);
    expect(ok).toBe('false:timeout');
    await new Promise((r) => setTimeout(r, 30));
    const done = await vm.run(`return tostring(done)`);
    expect(done).toBe('true');
  });

  it('vim.opt + vim.o + vim.g mapleader patterns', async () => {
    const ok = await vm.run(`
      vim.opt.relativenumber = true
      vim.o.shiftwidth = 2
      vim.g.mapleader = ','
      return tostring(vim.opt.relativenumber:get()) .. '|' .. vim.o.shiftwidth
    `);
    expect(ok).toBe('true|2');
  });

  it('vim.iter + vim.inspect style utility usage', async () => {
    const out = await vm.run(`
      local result = vim.iter({1, 2, 3, 4}):filter(function(v) return v % 2 == 0 end):map(function(v) return v * 10 end):totable()
      return result[1] .. '|' .. result[2]
    `);
    expect(out).toBe('20|40');
  });
});

// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { configureLuaRuntime } from '../lua-runtime';
import { LuaPluginVM } from './lua-vm';
import type { LuaBackend } from './backend';

const nodeRequire = createRequire(import.meta.url);
const glueWasm = nodeRequire.resolve('wasmoon/dist/glue.wasm');

interface LoggedBackend extends LuaBackend {
  log: string[];
  keymapCallbacks: Record<string, () => void>;
  eventHandlers: Record<string, (...args: any[]) => void>;
  commandCbs: Record<string, (args: string[]) => void>;
}

function makeBackend(): LoggedBackend {
  const log: string[] = [];
  const keymapCallbacks: Record<string, () => void> = {};
  const eventHandlers: Record<string, (...args: any[]) => void> = {};
  const commandCbs: Record<string, (args: string[]) => void> = {};
  const backend: LoggedBackend = {
    log,
    keymapCallbacks,
    eventHandlers,
    commandCbs,
    executeCommand: (cmd) => { log.push(`cmd:${cmd}`); },
    registerCommand: (name, cb) => { commandCbs[name] = cb; log.push(`reg:${name}`); },
    delCommand: (name) => { delete commandCbs[name]; log.push(`delcmd:${name}`); },
    getBuffer: () => ['alpha', 'beta', 'gamma'],
    setBuffer: (lines) => { log.push(`setBuffer:${lines.join('|')}`); },
    getCurrentFilePath: () => '/work/file.txt',
    getCursor: () => ({ x: 0, y: 1 }),
    setCursor: (x, y) => { log.push(`setCursor:${x},${y}`); },
    getMode: () => 'Normal',
    on: (event, cb) => { eventHandlers[event] = cb; log.push(`on:${event}`); },
    registerKeymap: (mode, lhs, cb) => { keymapCallbacks[`${mode}:${lhs}`] = cb; log.push(`keymap:${mode}:${lhs}`); },
    delKeymap: (mode, lhs) => { delete keymapCallbacks[`${mode}:${lhs}`]; log.push(`delkeymap:${mode}:${lhs}`); },
    schedule: (cb) => { setTimeout(cb, 0); },
    defer: (cb, ms) => { setTimeout(cb, ms); },
    showMessage: (msg) => { log.push(`msg:${msg}`); },
    fs: null,
  };
  return backend;
}

let vm: LuaPluginVM;
let backend: LoggedBackend;

beforeAll(async () => {
  configureLuaRuntime({ wasmUrl: glueWasm });
  backend = makeBackend();
  const modules: Record<string, string> = {
    'my.utils': 'local M = {}; M.answer = function() return 42 end; return M',
    'my.dep': 'local u = require("my.utils"); return { combined = u.answer() + 1 }',
  };
  vm = await LuaPluginVM.create(backend, (name) => modules[name] ?? null);
});

afterAll(() => {
  vm.close();
});

describe('LuaPluginVM vim.* shim', () => {
  it('runs a basic plugin and exposes vim.cmd / executeCommand', async () => {
    backend.log.length = 0;
    await vm.run(`vim.cmd('echo hello')\nvim.api.nvim_command('w')`);
    expect(backend.log).toContain('cmd:echo hello');
    expect(backend.log).toContain('cmd:w');
  });

  it('reads the buffer via vim.api.nvim_buf_get_lines', async () => {
    const out = await vm.engine.doString(`
      local all = vim.api.nvim_buf_get_lines(0, 0, -1, false)
      local slice = vim.api.nvim_buf_get_lines(0, 1, 2, false)
      return all[2] .. '|' .. slice[1]
    `);
    expect(out).toBe('beta|beta');
  });

  it('writes through vim.g and reads it back from JS-referenced state', async () => {
    await vm.run(`vim.g.my_flag = 'yes'\nvim.g.count = 5`);
    expect(backend.log, 'no buffer write expected').not.toContain('setBuffer:');
    const v = await vm.run(`return vim.g.my_flag .. '|' .. vim.g.count`);
    expect(v).toBe('yes|5');
  });

  it('supports nvim_buf_set_lines', async () => {
    await vm.run(`vim.api.nvim_buf_set_lines(0, 1, 2, false, {'replaced', 'extra'})`);
    expect(backend.log).toContain('setBuffer:alpha|replaced|extra|gamma');
  });

  it('creates user commands and dispatches them', async () => {
    await vm.run(`vim.api.nvim_create_user_command('LuaHello', function(opts)
      vim.cmd('echo HELLO_' .. opts.fargs[1])
    end, { nargs = 1 })`);
    expect(backend.log).toContain('reg:LuaHello');
    backend.log.length = 0;
    backend.commandCbs['LuaHello']?.(['world']);
    expect(backend.log).toContain('cmd:echo HELLO_world');
  });

  it('registers keymaps (translating <leader>/<C-...>)', async () => {
    await vm.run(`vim.keymap.set('n', '<leader>q', function() vim.cmd('q') end)`);
    expect(backend.keymapCallbacks['n:leaderq']).toBeTypeOf('function');
    backend.keymapCallbacks['n:leaderq']?.();
    expect(backend.log).toContain('cmd:q');
  });

  it('registers autocmds and fires on engine events', async () => {
    backend.log.length = 0;
    backend.eventHandlers = {};
    backend.on = (event, cb) => {
      backend.eventHandlers[event] = cb;
      backend.log.push(`on:${event}`);
    };
    await vm.run(`
      __netvim_capture = {}
      vim.api.nvim_create_autocmd('BufReadPost', { callback = function(e)
        __netvim_capture.buf = e.buf
        __netvim_capture.file = e.match
        vim.api.nvim_command('lua-ran')
      end })
    `);
    expect(backend.log).toContain('on:BufferLoaded');
    backend.eventHandlers['BufferLoaded']?.({ path: '/work/file.txt' });
    const captured = await vm.run(`return __netvim_capture.buf .. '|' .. __netvim_capture.file`);
    expect(captured).toBe('1|/work/file.txt');
    expect(backend.log).toContain('cmd:lua-ran');
  });

  it('resolves require() for user modules', async () => {
    const v = await vm.run(`
      local utils = require('my.utils')
      return utils.answer()
    `);
    expect(v).toBe(42);
  });

  it('supports require between user modules', async () => {
    const v = await vm.run(`return require('my.dep').combined`);
    expect(v).toBe(43);
  });

  it('implements vim.fn with a lazy proxy (expand / tolower)', async () => {
    const v = await vm.run(`
      local name = vim.fn.expand('%')
      local low = vim.fn.tolower('ABC')
      return name .. '|' .. low
    `);
    expect(v).toBe('/work/file.txt|abc');
  });

  it('handles vim.opt and vim.o reads/writes', async () => {
    await vm.run(`vim.opt.shiftwidth = 4\nvim.o.background = 'dark'`);
    const v = await vm.run(`return vim.opt.shiftwidth:get() .. '|' .. vim.o.background`);
    expect(v).toBe('4|dark');
  });

  it('runs a full plugin with setup() convention (lazy.nvim style)', async () => {
    const plugin = `
      local M = {}
      M.config = { name = nil }
      function M.setup(opts)
        M.config.name = opts.name or 'default'
      end
      M.greet = function() return 'hello ' .. M.config.name end
      return M
    `;
    const ok = await vm.runPlugin('greeter', plugin);
    expect(ok).toBe(true);
    const v = await vm.run(`local g = require('greeter'); return g.greet()`);
    expect(v).toBe('hello default');
  });

  it('supports vim.schedule and vim.wait', async () => {
    const v = await vm.run(`
      local done = false
      vim.schedule(function() done = true end)
      return tostring(done)
    `);
    expect(v).toBe('false'); // scheduled runs async
    await new Promise((r) => setTimeout(r, 20));
    const done = await vm.run(`return tostring(done)`);
    void done;
    const waited = await vm.run(`
      local counter = 0
      local ok, why = vim.wait(5, function() counter = counter + 1; return counter >= 3 end)
      return tostring(ok) .. ':' .. why
    `);
    expect(waited).toBe('true:ok');
  });

  it('loads plugins via loadLuaPluginFromSource path and lists them', async () => {
    await vm.runPlugin('sillyplug', `vim.g.plugged_in = true`);
    expect(vm.getLoadedPlugins()).toContain('sillyplug');
  });
});

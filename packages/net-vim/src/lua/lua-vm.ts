import { createLuaEngine } from '../lua-runtime';
import type { LuaBackend } from './backend';
import { createVimShim, VimShim } from './shim';
import type { LuaModuleLoader } from './shim';
import { createTreesitter, type TreesitterAPI } from './treesitter';

const BOOTSTRAP = `
-- Expose vim.* tables so require('vim.foo') works like in Neovim
package.loaded['vim'] = vim
package.loaded['vim.api'] = vim.api
package.loaded['vim.keymap'] = vim.keymap
package.loaded['vim.opt'] = vim.opt
package.loaded['vim.opt_local'] = vim.opt_local
package.loaded['vim.opt_global'] = vim.opt_global
package.loaded['vim.o'] = vim.o
package.loaded['vim.bo'] = vim.bo
package.loaded['vim.wo'] = vim.wo
package.loaded['vim.go'] = vim.go
package.loaded['vim.v'] = vim.v
package.loaded['vim.g'] = vim.g
package.loaded['vim.b'] = vim.b
package.loaded['vim.w'] = vim.w
package.loaded['vim.env'] = vim.env
package.loaded['vim.fn'] = vim.fn
package.loaded['vim.fs'] = vim.fs
package.loaded['vim.log'] = vim.log

-- User module loader (mirrors Neovim's runtimepath lua/ modules)
local function netvim_searcher(name)
  local src = __netvim.load_module(name)
  if type(src) ~= 'string' then
    return "module '" .. name .. "' not found"
  end
  local chunk, err = load(src, '=' .. name, 't', _ENV)
  if not chunk then return err end
  return chunk, name
end
table.insert(package.searchers, 1, netvim_searcher)

-- Lua 5.1 compat (Neovim runs LuaJIT): global unpack
if _G.unpack == nil then
  _G.unpack = table.unpack
end

-- vim.pretty_print convenience
vim.pretty_print = function(...) print(vim.inspect({...})) end

--
-- Coroutine machinery (drives blocking getchar for which-key style plugins)
-- Convention: {{vim-important}} all coroutine starts happen with a genuine Lua
-- function reference (never proxied through JS) so coroutine.yield stays legal.
--
__netvim_coroutines = {}
__netvim_counter = 0
__netvim_last_pending = nil
__netvim_last_result = nil

function __netvim_start_coroutine(fn)
  __netvim_counter = __netvim_counter + 1
  local id = __netvim_counter
  local co = coroutine.create(fn)
  __netvim_coroutines[id] = co
  local ok, err = coroutine.resume(co)
  if not ok then
    __netvim_coroutines[id] = nil
    __netvim_last_pending = nil
    error(err, 0)
  end
  if coroutine.status(co) == "suspended" then
    __netvim_last_pending = id
    return true
  end
  __netvim_coroutines[id] = nil
  __netvim_last_pending = nil
  return false
end

function __netvim_resume_coroutine(id, key)
  local co = __netvim_coroutines[id]
  if not co then
    __netvim_last_pending = nil
    return true
  end
  local rets = table.pack(coroutine.resume(co, key))
  local ok, err = rets[1], rets[2]
  if not ok then
    __netvim_coroutines[id] = nil
    __netvim_last_pending = nil
    error(err, 0)
  end
  if coroutine.status(co) == "suspended" then
    __netvim_last_pending = id
    return false
  end
  __netvim_coroutines[id] = nil
  __netvim_last_pending = nil
  __netvim_last_result = table.unpack(rets, 2)
  return true
end

function __netvim_drop_coroutine(id)
  __netvim_coroutines[id] = nil
  if __netvim_last_pending == id then
    __netvim_last_pending = nil
  end
end

--
-- getcharstr / getchar: consult the JS char queue first, otherwise yield the
-- coroutine so the engine can resume us with the next key.
-- NOTE: these must be genuine Lua functions in genuine Lua tables. Writing a
-- Lua function back through the JS proxy (e.g. vim.fn.getcharstr = f) crashes
-- wasmoon, so we shadow vim.fn/vim.keymap/vim with pure-Lua tables below.
--
local netvim_getcharstr = function(timeout)
  local key = __netvim.read_char()
  if key then return key end
  if timeout and timeout > 0 then return "" end
  coroutine.yield("__netvim_wait_char__")
  return __netvim.read_char() or ""
end

local js_vim = vim

local fn_proxy = setmetatable({}, {
  __index = function(_, name)
    if name == "getcharstr" or name == "getchar" then
      return netvim_getcharstr
    end
    return js_vim.fn[name]
  end,
})

local keymap_proxy = {}
keymap_proxy.set = function(mode, lhs, rhs, opts)
  local target = rhs
  if type(rhs) == "function" then
    local fn = rhs
    target = function()
      return __netvim_start_coroutine(fn)
    end
    __netvim_last_result = nil
  end
  return js_vim.keymap.set(mode, lhs, target, opts)
end
keymap_proxy.del = function(mode, lhs)
  return js_vim.keymap.del(mode, lhs)
end
keymap_proxy.clear = function(mode)
  return js_vim.keymap.clear(mode)
end

-- Shadow the global vim table: everything forwards to the JS shim object,
-- except vim.fn (getchar overrides) and vim.keymap (coroutine wrapper).
local vim_proxy = setmetatable({}, {
  __index = function(_, name)
    if name == "fn" then return fn_proxy end
    if name == "keymap" then return keymap_proxy end
    return js_vim[name]
  end,
})
vim = vim_proxy

--
-- Pure-Lua table helpers (Neovim-compatible).  Kept in Lua so tables never
-- round-trip through wasmoon's JS proxy layer (which corrupts 0-based arrays
-- and nested tables).  These are set as explicit fields on the Lua vim table.
--
local function nv_deepcopy(orig, cache)
  if orig == vim.NIL then return vim.NIL end
  if type(orig) == 'userdata' or type(orig) == 'thread' then
    error('Cannot deepcopy object of type ' .. type(orig))
  end
  if type(orig) ~= 'table' then return orig end
  if cache and cache[orig] then return cache[orig] end
  local copy = {}
  if cache then cache[orig] = copy end
  for k, v in pairs(orig) do
    copy[nv_deepcopy(k, cache)] = nv_deepcopy(v, cache)
  end
  return setmetatable(copy, getmetatable(orig))
end
vim.deepcopy = function(orig, noref)
  return nv_deepcopy(orig, not noref and {} or nil)
end

local function nv_can_merge(v)
  return type(v) == 'table' and (next(v) == nil or not vim.isarray(v))
end
local function nv_tbl_extend(behavior, deep_extend, ...)
  if behavior ~= 'error' and behavior ~= 'keep' and behavior ~= 'force' then
    error('invalid "behavior": ' .. tostring(behavior))
  end
  local ret = {}
  for i = 1, select('#', ...) do
    local tbl = select(i, ...)
    if type(tbl) == 'table' then
      for k, v in pairs(tbl) do
        if deep_extend and nv_can_merge(v) and nv_can_merge(ret[k]) then
          ret[k] = nv_tbl_extend(behavior, true, ret[k], v)
        elseif behavior ~= 'force' and ret[k] ~= nil then
          if behavior == 'error' then
            error('key found in more than one map: ' .. tostring(k))
          end
        else
          ret[k] = v
        end
      end
    end
  end
  return ret
end
vim.tbl_extend = function(behavior, ...) return nv_tbl_extend(behavior, false, ...) end
vim.tbl_deep_extend = function(behavior, ...) return nv_tbl_extend(behavior, true, ...) end

vim.tbl_keys = function(t)
  local keys = {}
  for k in pairs(t or {}) do table.insert(keys, k) end
  return keys
end
vim.tbl_values = function(t)
  local vals = {}
  for _, v in pairs(t or {}) do table.insert(vals, v) end
  return vals
end
vim.tbl_map = function(func, t)
  local r = {}
  for k, v in pairs(t or {}) do r[k] = func(v) end
  return r
end
vim.tbl_filter = function(func, t)
  local r = {}
  for _, v in pairs(t or {}) do
    if func(v) then r[#r + 1] = v end
  end
  return r
end
vim.tbl_isempty = function(t)
  if type(t) ~= 'table' then return true end
  return next(t) == nil
end
vim.tbl_get = function(o, ...)
  local keys = { ... }
  if #keys == 0 then return nil end
  for i, k in ipairs(keys) do
    o = o[k]
    if o == nil then return nil end
    if type(o) ~= 'table' and next(keys, i) then return nil end
  end
  return o
end
vim.tbl_count = function(t)
  local n = 0
  for _ in pairs(t or {}) do n = n + 1 end
  return n
end
vim.tbl_contains = function(t, value)
  for _, v in pairs(t or {}) do
    if v == value then return true end
  end
  return false
end
vim.isarray = function(t)
  if type(t) ~= 'table' then return false end
  local count = 0
  for k, _ in pairs(t) do
    if type(k) == 'number' and k == math.floor(k) then count = count + 1 else return false end
  end
  return count > 0
end
vim.islist = function(t)
  if type(t) ~= 'table' then return false end
  if next(t) == nil then return true end
  local j = 1
  for _ in pairs(t) do
    if t[j] == nil then return false end
    j = j + 1
  end
  return true
end

package.loaded['vim'] = vim
package.loaded['vim.fn'] = vim.fn
package.loaded['vim.keymap'] = vim.keymap
`;

export interface LuaPluginVMOptions {
  registerLineRenderer?: (opts: any) => void;
  rerender?: () => void;
  readGrammarBytes?: (lang: string) => Promise<Uint8Array | null>;
  cdnBase?: string;
  preload?: string[] | false;
}

export class LuaPluginVM {
  private handle: any;
  readonly engine: any;
  readonly shim: VimShim;
  readonly treesitter: TreesitterAPI;
  private loadedPlugins: string[] = [];
  private charQueue: string[] = [];
  private pendingId: number | null = null;

  private constructor(handle: any, engine: any, shim: VimShim, treesitter: TreesitterAPI) {
    this.handle = handle;
    this.engine = engine;
    this.shim = shim;
    this.treesitter = treesitter;
  }

  static async create(backend: LuaBackend, moduleLoader: LuaModuleLoader, options: LuaPluginVMOptions = {}): Promise<LuaPluginVM> {
    const shim = createVimShim(backend, moduleLoader);
    const handle = await createLuaEngine();
    const engine = handle.engine;
    const treesitter = createTreesitter({
      backend,
      registerLineRenderer: options.registerLineRenderer ?? (() => {}),
      rerender: options.rerender,
      readGrammarBytes: options.readGrammarBytes,
      cdnBase: options.cdnBase,
      preload: options.preload,
    });
    const vm = new LuaPluginVM(handle, engine, shim, treesitter);
    await vm.init();
    return vm;
  }

  private async init() {
    const helpers = {
      load_module: (name: string) => this.shim.moduleLoader(name),
      schedule: (cb: any, ms: number) => {
        setTimeout(() => {
          try { if (typeof cb === 'function') cb(); } catch (err) { console.error('[lua] scheduled callback error:', err); }
        }, ms ?? 0);
      },
      now: () => Date.now(),
      read_char: () => this.charQueue.shift(),
    };
    this.engine.global.set('__netvim', helpers);
    this.engine.global.set('vim', this.shim.vim);
    await this.engine.doString(BOOTSTRAP);
    this.treesitter.install(this.shim.vim);
    await this.engine.doString(`package.loaded['vim.treesitter'] = vim.treesitter`);
  }

  async run(source: string): Promise<any> {
    return this.engine.doString(source);
  }

  /**
   * Invokes a Lua keymap callback inside a coroutine.  If it yields while
   * waiting for a character, the pending coroutine id is remembered so the
   * engine can resume it with the next typed key.
   */
  invokeKeymapCallback(cb: () => void): void {
    if (typeof cb !== 'function') return;
    this.pendingId = null;
    try {
      cb();
    } catch (err) {
      console.error('[LuaVM] keymap callback error:', err);
      this.dropPending();
      return;
    }
    this.syncPending();
  }

  /**
   * Reads __netvim_last_pending from Lua into this.pendingId.
   */
  syncPending(): void {
    try {
      const id = this.engine.global.get('__netvim_last_pending');
      this.pendingId = typeof id === 'number' && id > 0 ? id : null;
    } catch {
      this.pendingId = null;
    }
  }

  hasPendingChar(): boolean {
    return this.pendingId !== null;
  }

  getPendingId(): number | null {
    return this.pendingId;
  }

  /**
   * Resumes a waiting coroutine with the next key.  Returns true if the
   * coroutine is still waiting for another key afterwards.
   */
  resumeWithChar(key: string): boolean {
    if (this.pendingId === null) return false;
    const id = this.pendingId;
    this.charQueue.push(key);
    try {
      const res = this.engine.global.call('__netvim_resume_coroutine', id, key);
      // __netvim_resume_coroutine returns false when the coroutine is still
      // suspended (waiting for the next char), true when it completed.
      const done = Array.isArray(res) ? !!res[0] : true;
      if (done) {
        this.pendingId = null;
        return false;
      }
      this.syncPending();
      return this.pendingId !== null;
    } catch (err) {
      console.error('[LuaVM] resume_coroutine error:', err);
      this.dropPending();
      return false;
    }
  }

  dropPending(): void {
    if (this.pendingId !== null) {
      try { this.engine.global.call('__netvim_drop_coroutine', this.pendingId); } catch { /* ignore */ }
      this.pendingId = null;
    }
    while (this.charQueue.length) this.charQueue.shift();
  }

  async runPlugin(name: string, source: string): Promise<boolean> {
    try {
      const luaName = name.replace(/\.lua$/i, '');
      const runner = `
        local chunk, err = load(${JSON.stringify(source)}, '=${luaName}', 't', _ENV)
        if not chunk then
          error(tostring(err))
        end
        local m1, m2 = chunk()
        local mod = (m1 == nil and m2) or m1
        if type(mod) == 'table' then
          package.loaded[${JSON.stringify(luaName)}] = mod
          if type(mod.setup) == 'function' then
            mod.setup({})
          end
        end
      `;
      await this.engine.doString(runner);
      this.loadedPlugins.push(name);
      return true;
    } catch (err) {
      console.error(`[LuaVM] Failed to run plugin ${name}:`, err);
      return false;
    }
  }

  getLoadedPlugins() {
    return [...this.loadedPlugins];
  }

  close() {
    try { this.handle.close(); } catch { /* noop */ }
  }
}
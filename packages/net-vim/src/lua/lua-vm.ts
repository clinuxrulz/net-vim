import { createLuaEngine } from '../lua-runtime';
import type { LuaBackend } from './backend';
import { createVimShim, VimShim } from './shim';
import type { LuaModuleLoader } from './shim';

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
package.loaded['vim.g'] = vim.g
package.loaded['vim.b'] = vim.b
package.loaded['vim.w'] = vim.w
package.loaded['vim.v'] = vim.v
package.loaded['vim.env'] = vim.env
package.loaded['vim.fn'] = vim.fn
package.loaded['vim.fs'] = vim.fs

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

-- vim.pretty_print convenience
vim.pretty_print = function(...) print(vim.inspect({...})) end
`;

export class LuaPluginVM {
  private handle: any;
  readonly engine: any;
  readonly shim: VimShim;
  private loadedPlugins: string[] = [];

  private constructor(handle: any, engine: any, shim: VimShim) {
    this.handle = handle;
    this.engine = engine;
    this.shim = shim;
  }

  static async create(backend: LuaBackend, moduleLoader: LuaModuleLoader): Promise<LuaPluginVM> {
    const shim = createVimShim(backend, moduleLoader);
    const handle = await createLuaEngine();
    const engine = handle.engine;
    const vm = new LuaPluginVM(handle, engine, shim);
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
    };
    this.engine.global.set('__netvim', helpers);
    this.engine.global.set('vim', this.shim.vim);
    await this.engine.doString(BOOTSTRAP);
  }

  async run(source: string): Promise<any> {
    return this.engine.doString(source);
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

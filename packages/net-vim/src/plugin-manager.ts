import type { VimAPI, VimMode, GutterOptions, LineRendererOptions } from './types';
import { h, Fragment } from './solid-universal-tui';
import { autoFS } from './opfs-util';
import { LuaPluginVM } from './lua/lua-vm';
import { createLuaBackendFromAPI } from './lua/backend';
import { buildModuleLoader } from './lua/modules';

// Define the plugin-specific API that each plugin will receive
export interface ScopedVimAPI extends VimAPI {
  // Add a simple storage bucket just for this plugin
  storage: {
    get: (key: string) => any;
    set: (key: string, value: any) => void;
  };
  // Log with plugin identification
  log: (...args: any[]) => void;
  // File system access (workspace active FS)
  fs: {
    readFile: (path: string) => Promise<string | null>;
    writeFile: (path: string, content: string) => Promise<void>;
    listDirectory: (path: string) => Promise<string[]>;
    isDirectory: (path: string) => Promise<boolean>;
  };
  // Configuration access (uses current active FS, typically OPFS or user provided)
  configFs: {
    readFile: (path: string) => Promise<string | null>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  // UI helpers
  h: typeof h;
  // Tools
  babel: any;
}

export interface PluginMetadata {
  name: string;
  author?: string;
  version?: string;
  description?: string;
}

export interface WebVimPlugin {
  metadata: PluginMetadata;
  setup: (api: ScopedVimAPI) => void | Promise<void>;
}

export class PluginManager {
  private plugins: Map<string, WebVimPlugin> = new Map();
  private pluginStates: Map<string, Map<string, any>> = new Map();
  private getBaseAPI: () => VimAPI;
  private luaVM: Promise<LuaPluginVM> | null = null;
  private luaPlugins: Set<string> = new Set();

  constructor(getBaseAPI: () => VimAPI) {
    this.getBaseAPI = getBaseAPI;
  }

  private getLuaVM(): Promise<LuaPluginVM> {
    if (!this.luaVM) {
      const api = this.getBaseAPI();
      this.luaVM = (async () => {
        const loader = await buildModuleLoader(api.getFS());
        const backend = createLuaBackendFromAPI(api);
        const vm = await LuaPluginVM.create(backend, loader);
        return vm;
      })();
    }
    return this.luaVM;
  }

  /**
   * Loads a Lua plugin from a raw source string (Neovim-style `vim.*` API).
   */
  async loadLuaPluginFromSource(name: string, luaSource: string) {
    console.log(`[PluginManager] Starting to load Lua plugin: ${name}`);
    try {
      const vm = await this.getLuaVM();
      const ok = await vm.runPlugin(name, luaSource);
      if (ok) this.luaPlugins.add(name);
      return ok;
    } catch (err) {
      console.error(`[PluginManager] Failed to load Lua plugin ${name}:`, err);
      return false;
    }
  }

  getLoadedLuaPlugins() {
    return Array.from(this.luaPlugins);
  }

  /**
   * Loads a TypeScript plugin from a raw string
   */
  async loadPluginFromSource(name: string, tsSource: string) {
    console.log(`[PluginManager] Starting to load plugin: ${name}`);

    try {
      const babel = this.getBaseAPI().babel;
      if (!babel) {
        throw new Error(`Babel not found while trying to load plugin ${name}. Make sure VimEngine is initialized.`);
      }

      console.log(`[PluginManager] Transpiling ${name}...`);
      // Transpile TypeScript to JavaScript using Babel Standalone
      const result = babel.transform(tsSource, {
        filename: `${name}.tsx`,
        presets: ['typescript'],
        plugins: [
          ['transform-modules-commonjs', { loose: true }],
          ['transform-react-jsx', { pragma: 'h', pragmaFrag: 'Fragment' }]
        ],
        retainLines: true,
      });

      const jsCode = result.code;
      console.log(`[PluginManager] Transpiled ${name} successfully. Running code...`);

      // Wrap the code in a function to isolate it and provide our API
      const module = { exports: {} as any };
      const exports = module.exports;

      const runPlugin = new Function('module', 'exports', 'require', 'h', 'Fragment', jsCode);
      
      // Execute the plugin code
      runPlugin(module, exports, (mod: string) => {
          throw new Error(`Require is not supported in plugins: ${mod}`);
      }, h, Fragment);

      console.log(`[PluginManager] Ran ${name} successfully. Extracting plugin...`);
      const plugin: WebVimPlugin = module.exports.default || module.exports;

      if (!plugin || typeof plugin.setup !== 'function') {
        throw new Error(`Plugin ${name} does not export a valid 'setup' function.`);
      }

      console.log(`[PluginManager] Registering ${name}...`);
      await this.registerPlugin(name, plugin);
      return true;
    } catch (err) {
      console.error(`[PluginManager] Failed to load plugin ${name}:`, err);
      return false;
    }
  }

  /**
   * Loads a plugin from a WebVimPlugin object
   */
  async loadPlugin(plugin: WebVimPlugin) {
    const id = plugin.metadata?.name || `plugin-${Math.random().toString(36).slice(2, 9)}`;
    await this.registerPlugin(id, plugin);
    return true;
  }

  private async registerPlugin(id: string, plugin: WebVimPlugin) {
    const name = plugin.metadata?.name || id;
    console.log(`[PluginManager] Registering plugin: ${name}`);
    this.plugins.set(id, plugin);
    this.pluginStates.set(id, new Map());

    // Create the Scoped API for this plugin
    const scopedApi = this.createScopedAPI(id);

    // Initialize the plugin
    try {
      console.log(`[PluginManager] Calling setup for plugin: ${name}`);
      await plugin.setup(scopedApi);
      console.log(`[PluginManager] Plugin "${name}" initialized successfully.`);
    } catch (err) {
      console.error(`[PluginManager] Error during plugin "${name}" setup:`, err);
    }
  }

  private createScopedAPI(pluginId: string): ScopedVimAPI {
    const baseApi = this.getBaseAPI();
    const pluginState = this.pluginStates.get(pluginId)!;

    return {
      ...baseApi,
      
      // Plugin-specific storage
      storage: {
        get: (key: string) => pluginState.get(key),
        set: (key: string, value: any) => pluginState.set(key, value),
      },

      // Identify logs
      log: (...args: any[]) => {
        console.log(`[Plugin: ${pluginId}]`, ...args);
      },

      // Workspace File system access (uses current active FS)
      fs: {
        readFile: (path: string) => baseApi.getFS().readFile(path),
        writeFile: (path: string, content: string) => baseApi.getFS().writeFile(path, content),
        listDirectory: (path: string) => baseApi.getFS().listDirectory(path),
        isDirectory: (path: string) => baseApi.getFS().isDirectory(path),
      },

      // Configuration access (uses current active FS, typically OPFS or user provided)
      configFs: {
        readFile: (path: string) => autoFS.readFile(path),
        writeFile: (path: string, content: string) => autoFS.writeFile(path, content),
      },

      h: h,
    };
  }

  getLoadedPlugins() {
    return Array.from(this.plugins.values()).map(p => p.metadata);
  }
}

import type { VimAPI, VimMode } from './types';

// Define the plugin-specific API that each plugin will receive
export interface ScopedVimAPI extends VimAPI {
  // Add a simple storage bucket just for this plugin
  storage: {
    get: (key: string) => any;
    set: (key: string, value: any) => void;
  };
  // Log with plugin identification
  log: (...args: any[]) => void;
  // File system access (logical isolation is harder here, but we'll provide the tool)
  fs: {
    readFile: (path: string) => Promise<string | null>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
}

export interface PluginMetadata {
  name: string;
  author?: string;
  version?: string;
  description?: string;
}

export interface WebVimPlugin {
  metadata: PluginMetadata;
  setup: (api: ScopedVimAPI) => void;
}

// Global Babel access for TS to JS on the fly
declare const Babel: any;

import { getConfigFile, writeConfigFile } from './opfs-util';

export class PluginManager {
  private plugins: Map<string, WebVimPlugin> = new Map();
  private pluginStates: Map<string, Map<string, any>> = new Map();
  private getBaseAPI: () => VimAPI;

  constructor(getBaseAPI: () => VimAPI) {
    this.getBaseAPI = getBaseAPI;
  }

  /**
   * Loads a TypeScript plugin from a raw string
   */
  async loadPluginFromSource(name: string, tsSource: string) {
    console.log(`[PluginManager] Loading plugin: ${name}`);

    try {
      // Transpile TypeScript to JavaScript using Babel Standalone
      // We add 'transform-modules-commonjs' to handle 'export' statements
      const result = Babel.transform(tsSource, {
        filename: `${name}.ts`,
        presets: ['typescript'],
        plugins: [
          ['transform-modules-commonjs', { loose: true }]
        ],
        retainLines: true,
      });

      const jsCode = result.code;

      // Wrap the code in a function to isolate it and provide our API
      // We expect the plugin to be a CommonJS-like module or an ESM-like module
      // For simplicity, we'll expect it to assign to 'module.exports' or 'exports'
      const module = { exports: {} as any };
      const exports = module.exports;

      const runPlugin = new Function('module', 'exports', 'require', jsCode);
      
      // Execute the plugin code
      runPlugin(module, exports, (mod: string) => {
          throw new Error(`Require is not supported in plugins: ${mod}`);
      });

      const plugin: WebVimPlugin = module.exports.default || module.exports;

      if (!plugin || typeof plugin.setup !== 'function') {
        throw new Error(`Plugin ${name} does not export a valid 'setup' function.`);
      }

      this.registerPlugin(name, plugin);
      return true;
    } catch (err) {
      console.error(`[PluginManager] Failed to load plugin ${name}:`, err);
      return false;
    }
  }

  private registerPlugin(id: string, plugin: WebVimPlugin) {
    const name = plugin.metadata?.name || id;
    this.plugins.set(id, plugin);
    this.pluginStates.set(id, new Map());

    // Create the Scoped API for this plugin
    const scopedApi = this.createScopedAPI(id);

    // Initialize the plugin
    try {
      plugin.setup(scopedApi);
      console.log(`[PluginManager] Plugin "${name}" initialized successfully.`);
    } catch (err) {
      console.error(`[PluginManager] Error during plugin "${name}" setup:`, err);
    }
  }

  private createScopedAPI(pluginId: string): ScopedVimAPI {
    const baseApi = this.getBaseAPI();
    const pluginState = this.pluginStates.get(pluginId)!;

    // Use a Proxy or Object.create to ensure the plugin can't pollute the base API
    // but can still use it.
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

      // File system access
      fs: {
        readFile: (path: string) => getConfigFile(path),
        writeFile: (path: string, content: string) => writeConfigFile(path, content),
      }
    };
  }

  getLoadedPlugins() {
    return Array.from(this.plugins.values()).map(p => p.metadata);
  }
}

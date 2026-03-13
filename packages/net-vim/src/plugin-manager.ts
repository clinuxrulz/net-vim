import type { VimAPI, VimMode, GutterOptions, LineRendererOptions } from './types';
import { h, Fragment } from './solid-universal-tui';
import { autoFS } from './opfs-util';

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

  constructor(getBaseAPI: () => VimAPI) {
    this.getBaseAPI = getBaseAPI;
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
        presets: [
          ['typescript', { isTSX: true, allExtensions: true }]
        ],
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

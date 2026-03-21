import { render } from 'solid-js/web';
import VimEditor from './VimEditor';
import { VimEngine } from './vim-engine';
import { setFSImplementation, autoFS } from './opfs-util';
import type { FileSystem } from './types';
// @ts-ignore
import initWasm from './wasm/tui_engine';

export { default as VimEditor } from './VimEditor';
export * from './types';
export * from './vim-engine';
export * from './plugin-manager';
export * as prelude from './prelude';
export { PRELUDE_PLUGINS } from './prelude';

const CONFIG_PATH = '.config/net-vim/init.ts';

const DEFAULT_INIT = `
export default {
  metadata: {
    name: "user-init",
    description: "User startup configuration"
  },
  setup: async (api) => {
    api.log("Custom init.ts loaded!");
    
    // Load built-in plugins from the virtual prelude if desired:
    const lineNumbers = await api.configFs.readFile(".config/net-vim/prelude/line-numbers.tsx");
    if (lineNumbers) {
      await api.loadPluginFromSource("line-numbers", lineNumbers);
    }
    
    const contextMenu = await api.configFs.readFile(".config/net-vim/prelude/context-menu.tsx");
    if (contextMenu) {
      await api.loadPluginFromSource("context-menu", contextMenu);
    }

    const tsLsp = await api.configFs.readFile(".config/net-vim/prelude/ts-lsp.tsx");
    if (tsLsp) {
      await api.loadPluginFromSource("ts-lsp", tsLsp);
    }

    const externalFs = await api.configFs.readFile(".config/net-vim/prelude/external-fs.tsx");
    if (externalFs) {
      await api.loadPluginFromSource("external-fs", externalFs);
    }

    const eruda = await api.configFs.readFile(".config/net-vim/prelude/eruda.tsx");
    if (eruda) {
      await api.loadPluginFromSource("eruda", eruda);
    }

    const markdownSyntax = await api.configFs.readFile(".config/net-vim/prelude/markdown-syntax.tsx");
    if (markdownSyntax) {
      await api.loadPluginFromSource("markdown-syntax", markdownSyntax);
    }

    const fuzzyFinder = await api.configFs.readFile(".config/net-vim/prelude/fuzzy-finder.tsx");
    if (fuzzyFinder) {
      await api.loadPluginFromSource("fuzzy-finder", fuzzyFinder);
    }
  }
};
`;

export interface InitOptions {
  wasmUrl?: string;
  fileSystem?: FileSystem;
  autoCreateInit?: boolean;
}

export async function initNetVim(container: HTMLElement, options: InitOptions = {}) {
  // 0. Initialize File System if provided
  if (options.fileSystem) {
    setFSImplementation(options.fileSystem);
  }

  // 1. Initialize WASM before rendering the editor
  await initWasm(options.wasmUrl);

  const vim = new VimEngine(() => {}, () => {});
  await vim.init();

  // 2. Handle init.ts
  try {
    let initSource = await autoFS.readFile(CONFIG_PATH);
    if (!initSource && options.autoCreateInit) {
      console.log("[init] Auto-creating default init.ts at", CONFIG_PATH);
      await autoFS.writeFile(CONFIG_PATH, DEFAULT_INIT);
      initSource = await autoFS.readFile(CONFIG_PATH);
    }

    if (initSource) {
      await vim.loadPluginFromSource("init.ts", initSource);
    }
  } catch (e) {
    console.error("[init] Error loading init.ts:", e);
  }

  const dispose = render(() => <VimEditor engine={vim} />, container);
  
  return {
    vim,
    dispose
  };
}

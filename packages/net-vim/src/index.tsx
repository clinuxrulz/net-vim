import { render } from 'solid-js/web';
import VimEditor from './VimEditor';
import { VimEngine } from './vim-engine';
import { setFSImplementation } from './opfs-util';
import type { FileSystem } from './types';
// @ts-ignore
import initWasm from './wasm/tui_engine';

export { default as VimEditor } from './VimEditor';
export * from './types';
export * from './vim-engine';
export * from './plugin-manager';

export interface InitOptions {
  wasmUrl?: string;
  fileSystem?: FileSystem;
}

export async function initNetVim(container: HTMLElement, options: InitOptions = {}) {
  // 0. Initialize File System if provided
  if (options.fileSystem) {
    setFSImplementation(options.fileSystem);
  }

  // 1. Initialize WASM before rendering the editor
  await initWasm(options.wasmUrl);

  const vim = new VimEngine(() => {});
  await vim.init();

  const dispose = render(() => <VimEditor engine={vim} />, container);
  
  return {
    vim,
    dispose
  };
}

import { render } from 'solid-js/web';
import VimEditor from './VimEditor';
import { VimEngine } from './vim-engine';
// @ts-ignore
import initWasm from './wasm/tui_engine';

export { default as VimEditor } from './VimEditor';
export * from './types';
export * from './vim-engine';
export * from './plugin-manager';

export interface InitOptions {
  wasmUrl?: string;
}

export async function initNetVim(container: HTMLElement, options: InitOptions = {}) {
  // Initialize WASM before rendering the editor
  await initWasm(options.wasmUrl);

  const vim = new VimEngine(() => {});
  const dispose = render(() => <VimEditor engine={vim} />, container);
  
  return {
    vim,
    dispose
  };
}

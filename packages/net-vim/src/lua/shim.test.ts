import { describe, it, expect } from 'vitest';
import { createVimShim } from './shim';
import type { LuaBackend } from './backend';

function minimalBackend(): LuaBackend {
  return {
    executeCommand: () => {},
    registerCommand: () => {},
    delCommand: () => {},
    getBuffer: () => [],
    setBuffer: () => {},
    getCurrentFilePath: () => null,
    getCursor: () => ({ x: 0, y: 0 }),
    setCursor: () => {},
    getMode: () => 'Normal',
    on: () => {},
    registerKeymap: () => {},
    delKeymap: () => {},
    schedule: () => {},
    defer: () => {},
    showMessage: () => {},
    getLeader: () => ' ',
    getKeymaps: () => [],
    getViewport: () => ({ width: 80, height: 24 }),
    feedKeys: () => {},
    fs: null,
  };
}

describe('VimShim pure logic (no wasm)', () => {
  it('translates keycodes like neovim vim.keycode()', () => {
    const shim = createVimShim(minimalBackend(), () => null);
    expect(shim.translateKeycodes('<leader>e')).toBe(' e');
    expect(shim.translateKeycodes('<C-w>')).toBe('<C-W>');
    expect(shim.translateKeycodes('<CR>')).toBe('<CR>');
    expect(shim.translateKeycodes('<Esc>')).toBe('<Esc>');
    expect(shim.translateKeycodes('gd')).toBe('gd');
    expect(shim.translateKeycodes('<leader>ff')).toBe(' ff');
  });

  it('inspects nested tables and strings', () => {
    const shim = createVimShim(minimalBackend(), () => null);
    expect(shim.inspect({ a: 1, b: 'x' })).toContain('a');
    expect(shim.inspect([1, 2])).toBe('{ 1, 2 }');
    expect(shim.inspect('hi')).toBe('"hi"');
  });

  it('routes options through vim.o / vim.opt', () => {
    const shim = createVimShim(minimalBackend(), () => null);
    shim.vim.api.nvim_set_option('shiftwidth', 4);
    expect(shim.vim.api.nvim_get_option('shiftwidth')).toBe(4);
    shim.vim.api.nvim_set_option('mapleader', 'm');
    expect(shim.state.options.mapleader).toBe('m');
  });

  it('stores vars through vim.g', () => {
    const shim = createVimShim(minimalBackend(), () => null);
    shim.vim.api.nvim_set_var('foo', 42);
    expect(shim.state.vars.foo).toBe(42);
    expect(shim.vim.api.nvim_get_var('foo')).toBe(42);
  });

  it('provides NIL/empty_dict sentinels', () => {
    const shim = createVimShim(minimalBackend(), () => null);
    expect(shim.vim.NIL).toBeTruthy();
    const d = shim.vim.empty_dict();
    expect(typeof d).toBe('object');
  });

  it('exposes a stable vim.api with buffer helpers', () => {
    const shim = createVimShim(minimalBackend(), () => null);
    expect(typeof shim.vim.api.nvim_get_current_buf).toBe('function');
    expect(typeof shim.vim.api.nvim_buf_get_lines).toBe('function');
    expect(typeof shim.vim.api.nvim_create_autocmd).toBe('function');
    expect(typeof shim.vim.api.nvim_create_user_command).toBe('function');
  });
});

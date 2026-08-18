import type { FileSystem, VimAPI } from '../types';

export type KeymapCallback = (...args: any[]) => void;

export interface KeymapMeta {
  raw?: string;
  desc?: string;
  nowait?: boolean;
  silent?: boolean;
  noremap?: boolean;
  buffer?: number;
}

export interface KeymapEntry {
  mode: string;
  lhs: string;
  raw?: string;
  desc?: string;
  nowait?: boolean;
  silent?: boolean;
  noremap?: boolean;
  buffer?: number;
  callback?: () => void;
}

export interface FloatWindowConfig {
  row: number;
  col: number;
  width: number;
  height: number;
  border?: string | string[] | boolean;
  title?: string | any[];
  title_pos?: string;
  footer?: string | any[];
  footer_pos?: string;
  zindex?: number;
  relative?: string;
  style?: string;
  focusable?: boolean;
  noautocmd?: boolean;
}

export interface LuaBackend {
  executeCommand(cmd: string): void;
  registerCommand(name: string, cb: (args: string[]) => void): void;
  delCommand(name: string): void;
  getBuffer(): string[];
  setBuffer(lines: string[]): void;
  getCurrentFilePath(): string | null;
  getCursor(): { x: number; y: number };
  setCursor(x: number, y: number): void;
  getMode(): string;
  on(event: string, cb: (...args: any[]) => void): void;
  registerKeymap(mode: string, lhs: string, cb: KeymapCallback, meta?: KeymapMeta): void;
  delKeymap(mode: string, lhs: string): void;
  schedule(cb: () => void): void;
  defer(cb: () => void, ms: number): void;
  showMessage(msg: string): void;
  getLeader(): string;
  getKeymaps(mode?: string): KeymapEntry[];
  getViewport(): { width: number; height: number };
  feedKeys(seq: string): void;
  nvimCreateBuf?(listed: boolean): number;
  nvimOpenWin?(buf: number, enter: boolean, config: any): number;
  nvimWinSetConfig?(win: number, config: any): void;
  nvimWinGetConfig?(win: number): any;
  nvimWinClose?(win: number, force: boolean): void;
  nvimBufDelete?(buf: number): void;
  nvimWinIsValid?(win: number): boolean;
  nvimBufIsValid?(buf: number): boolean;
  nvimWinGetBuf?(win: number): number;
  nvimWinGetHeight?(win: number): number;
  nvimBufLineCount?(buf: number): number;
  nvimBufIsFloat?(buf: number): boolean;
  nvimBufSetLines?(buf: number, lines: string[]): void;
  nvimBufSetOption?(buf: number, name: string, value: any): void;
  nvimWinSetOption?(win: number, name: string, value: any): void;
  nvimSetFloatExtmark?(buf: number, line: number, col: number, opts: any): void;
  fs: FileSystem | null;
}

export function createLuaBackendFromAPI(api: VimAPI): LuaBackend {
  return {
    executeCommand: (cmd) => api.executeCommand(cmd),
    registerCommand: (name, cb) => api.registerCommand(name, cb),
    delCommand: (name) => {
      const del = (api as any).delCommand;
      if (typeof del === 'function') del(name);
    },
    getBuffer: () => api.getBuffer(),
    setBuffer: (lines) => api.setBuffer(lines),
    getCurrentFilePath: () => api.getCurrentFilePath(),
    getCursor: () => api.getCursor(),
    setCursor: (x, y) => api.setCursor(x, y),
    getMode: () => api.getMode(),
    on: (event, cb) => api.on(event as any, cb),
    registerKeymap: (mode, lhs, cb, meta) => {
      const reg = (api as any).registerKeymap;
      if (typeof reg === 'function') reg(mode, lhs, cb, meta);
    },
    delKeymap: (mode, lhs) => {
      const del = (api as any).delKeymap;
      if (typeof del === 'function') del(mode, lhs);
    },
    schedule: (cb) => setTimeout(cb, 0),
    defer: (cb, ms) => setTimeout(cb, ms),
    showMessage: (msg) => {
      const show = (api as any).showMessage;
      if (typeof show === 'function') show(msg);
    },
    getLeader: () => {
      const gl = (api as any).getLeader;
      return typeof gl === 'function' ? gl() : ' ';
    },
    getKeymaps: (mode) => {
      const gk = (api as any).getKeymaps;
      if (typeof gk !== 'function') return [];
      const all = gk();
      return mode ? all.filter((k: any) => k.mode === mode) : all;
    },
    getViewport: () => {
      const gv = (api as any).getViewport;
      if (typeof gv === 'function') return gv();
      return { width: 80, height: 24 };
    },
    feedKeys: (seq) => {
      const fk = (api as any).feedKeys;
      if (typeof fk === 'function') fk(seq);
    },
    nvimCreateBuf: (listed) => (api.nvimCreateBuf ? api.nvimCreateBuf(listed, false) : 0),
    nvimOpenWin: (buf, enter, config) => (api.nvimOpenWin ? api.nvimOpenWin(buf, enter, config) : -1),
    nvimWinSetConfig: (win, config) => { if (api.nvimWinSetConfig) api.nvimWinSetConfig(win, config); },
    nvimWinGetConfig: (win) => (api.nvimWinGetConfig ? api.nvimWinGetConfig(win) : {}),
    nvimWinClose: (win, force) => { if (api.nvimWinClose) api.nvimWinClose(win, force); },
    nvimBufDelete: (buf) => { if (api.nvimBufDelete) api.nvimBufDelete(buf); },
    nvimWinIsValid: (win) => (api.nvimWinIsValid ? api.nvimWinIsValid(win) : true),
    nvimBufIsValid: (buf) => (api.nvimBufIsValid ? api.nvimBufIsValid(buf) : true),
    nvimWinGetBuf: (win) => (api.nvimWinGetBuf ? api.nvimWinGetBuf(win) : 1),
    nvimWinGetHeight: (win) => (api.nvimWinGetHeight ? api.nvimWinGetHeight(win) : 10),
    nvimBufLineCount: (buf) => (api.nvimBufLineCount ? api.nvimBufLineCount(buf) : 1),
    nvimBufIsFloat: (buf) => (api.nvimBufIsFloat ? api.nvimBufIsFloat(buf) : false),
    nvimBufSetLines: (buf, lines) => { if (api.nvimBufSetLines) api.nvimBufSetLines(buf, 0, -1, false, lines); },
    nvimBufSetOption: (buf, name, value) => { if (api.nvimBufSetOption) api.nvimBufSetOption(buf, name, value); },
    nvimWinSetOption: (win, name, value) => { if (api.nvimWinSetOption) api.nvimWinSetOption(win, name, value); },
    nvimSetFloatExtmark: (buf, line, col, opts) => { if (api.nvimSetFloatExtmark) api.nvimSetFloatExtmark(buf, line, col, opts); },
    fs: api.getFS(),
  };
}
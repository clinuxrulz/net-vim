import type { FileSystem, VimAPI } from '../types';

export type KeymapCallback = (...args: any[]) => void;

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
  registerKeymap(mode: string, lhs: string, cb: KeymapCallback): void;
  delKeymap(mode: string, lhs: string): void;
  schedule(cb: () => void): void;
  defer(cb: () => void, ms: number): void;
  showMessage(msg: string): void;
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
    registerKeymap: (mode, lhs, cb) => {
      const reg = (api as any).registerKeymap;
      if (typeof reg === 'function') reg(mode, lhs, cb);
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
    fs: api.getFS(),
  };
}

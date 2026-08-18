import { decorateProxy, LuaMultiReturn } from 'wasmoon';
import type { LuaBackend, KeymapCallback } from './backend';

export type LuaModuleLoader = (name: string) => string | null;

export interface ExtendState {
  vars: Record<string, any>;
  bufVars: Record<number, Record<string, any>>;
  winVars: Record<number, Record<string, any>>;
  vVars: Record<string, any>;
  env: Record<string, string>;
  options: Record<string, any>;
  augroups: Map<string, number>;
  autocmds: Map<number, { events: string[]; group?: number; pattern?: string[]; cb: any }>;
  namespaces: Map<number, string>;
  autocmdCounter: number;
  namespaceCounter: number;
  extmarks: Map<string, Record<string, any>[]>;
}

const BUILTIN_EVENT_MAP: Record<string, string> = {
  BufEnter: 'BufferLoaded',
  BufRead: 'BufferLoaded',
  BufReadPost: 'BufferLoaded',
  VimEnter: 'BufferLoaded',
  BufWritePost: 'FileChanged',
  BufDelete: 'FileDeleted',
  CursorMoved: 'CursorMoved',
  TextChanged: 'TextChanged',
  ModeChanged: 'ModeChanged',
  Resize: 'Resize',
  FileChanged: 'FileChanged',
  FileDeleted: 'FileDeleted',
};

function toEngineEvent(ev: string): string | null {
  if (BUILTIN_EVENT_MAP[ev]) return BUILTIN_EVENT_MAP[ev];
  const sift = ev.replace(/^Buf/, 'Buffer');
  if (BUILTIN_EVENT_MAP[sift]) return BUILTIN_EVENT_MAP[sift];
  return null;
}

export function isNilSentinel(value: any): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && value.__netvimNil === true;
}

export function isEmptyDict(value: any): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && value.__netvimEmptyDict === true;
}

function isVimValue(value: any): boolean {
  return value !== undefined && value !== null && typeof value === 'object'
    && (value.__netvimNil === true || value.__netvimEmptyDict === true);
}

export class VimShim {
  readonly backend: LuaBackend;
  readonly state: ExtendState;
  readonly vim: Record<string, any>;
  private NIL_SENTINEL: any;
  readonly moduleLoader: LuaModuleLoader;

  constructor(backend: LuaBackend, moduleLoader: LuaModuleLoader) {
    this.backend = backend;
    this.moduleLoader = moduleLoader;
    this.state = {
      vars: {},
      bufVars: { 1: {} },
      winVars: { 1: {} },
      vVars: {},
      env: {},
      options: {},
      augroups: new Map(),
      autocmds: new Map(),
      namespaces: new Map(),
      autocmdCounter: 0,
      namespaceCounter: 0,
      extmarks: new Map(),
    };
    this.NIL_SENTINEL = decorateProxy({ __netvimNil: true }, { proxy: true });
    this.vim = this.buildVim();
  }

  private optionSet(name: string, value: any) {
    if (isVimValue(value)) {
      delete this.state.options[name];
      return;
    }
    this.state.options[name] = value;
    if (name === 'mapleader') {
      const sl = (this.backend as any).setLeader;
      if (typeof sl === 'function') sl(String(value));
    }
  }

  private optionGet(name: string): any {
    return this.state.options[name];
  }

  private buildVim(): Record<string, any> {
    const state = this.state;
    const opt = decorateProxy(new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        const m = String(prop);
        const asMethod = (method: string) => (name: string, value?: any) => this.optMethod(name, method, value);
        switch (m) {
          case 'get': return (name: string) => this.optionGet(name);
          case 'set': return asMethod('set');
          case 'override': return asMethod('override');
          case 'append': return asMethod('append');
          case 'prepend': return asMethod('prepend');
          case 'remove': return asMethod('remove');
          default: return this.optRead(m);
        }
      },
      set: (_t, prop, value) => { this.optionSet(String(prop), value); return true; },
      deleteProperty: (_t, prop) => { delete this.state.options[String(prop)]; return true; },
    }), { proxy: true });

    const o = decorateProxy(new Proxy({}, {
      get: (_t, prop) => { if (typeof prop === 'symbol') return undefined; return this.optionGet(String(prop)); },
      set: (_t, prop, value) => { this.optionSet(String(prop), value); return true; },
    }), { proxy: true });

    const bufVar = decorateProxy(new Proxy({}, {
      get: (_t, prop) => { if (typeof prop === 'symbol') return undefined; return state.bufVars[1]?.[String(prop)]; },
      set: (_t, prop, value) => { state.bufVars[1][String(prop)] = value; return true; },
    }), { proxy: true });

    const winVar = decorateProxy(new Proxy({}, {
      get: (_t, prop) => { if (typeof prop === 'symbol') return undefined; return state.winVars[1]?.[String(prop)]; },
      set: (_t, prop, value) => { state.winVars[1][String(prop)] = value; return true; },
    }), { proxy: true });

    const vVar = decorateProxy(new Proxy({}, {
      get: (_t, prop) => { if (typeof prop === 'symbol') return undefined; return state.vVars[String(prop)]; },
      set: (_t, prop, value) => { state.vVars[String(prop)] = value; return true; },
    }), { proxy: true });

    const env = decorateProxy(new Proxy({}, {
      get: (_t, prop) => { if (typeof prop === 'symbol') return undefined; return state.env[String(prop)]; },
      set: (_t, prop, value) => { state.env[String(prop)] = String(value); return true; },
    }), { proxy: true });

    const vim: Record<string, any> = {
      NIL: this.NIL_SENTINEL,
      version: { major: 0, minor: 6, patch: 3, prerelease: null },
      g: state.vars,
      b: bufVar,
      w: winVar,
      v: vVar,
      env,
      o,
      bo: o,
      wo: o,
      opt,
      opt_local: opt,
      opt_global: opt,
      empty_dict: () => Object.assign(Object.create(null), { __netvimEmptyDict: true }),
      inspect: (value: any) => this.inspect(value),
      keycode: (lhs: any) => this.translateKeycodes(String(lhs ?? '')),
      schedule: (cb: any) => this.backend.schedule(() => {
        if (typeof cb === 'function') { try { cb(); } catch (err) { console.error('[vim.schedule]', err); } }
      }),
      defer_fn: (cb: any, ms: number) => this.backend.defer(() => {
        if (typeof cb === 'function') { try { cb(); } catch (err) { console.error('[vim.defer_fn]', err); } }
      }, ms ?? 0),
      wait: (ms: number, cond?: any, cb?: any, _opts?: any) => this.wait(ms, cond, cb),
      cmd: this.makeVimCmd(),
      api: this.buildNvimAPI(),
      keymap: this.buildKeymap(),
      fn: this.buildFn(),
      fs: this.buildFS(),
      verify_cmd: (cmd: any) => cmd,
      iter: (value: any) => this.makeIter(value),
      tbl_deep_extend: (behavior: string, ...tables: any[]) => this.tblDeepExtend(behavior, tables),
      tbl_extend: (behavior: string, ...tables: any[]) => this.tblExtend(behavior, tables),
      tbl_contains: (list: any, value: any) => toArr(list).includes(value),
      tbl_keys: (obj: any) => obj ? Object.keys(obj) : [],
      tbl_values: (obj: any) => obj ? Object.values(obj) : [],
      tbl_flatten: (list: any) => {
        const out: any[] = [];
        toArr(list).forEach((item) => {
          if (Array.isArray(item)) out.push(...item);
          else out.push(item);
        });
        return out;
      },
      list_extend: (a: any, b: any) => { const arr = toArr(a); arr.push(...toArr(b)); return arr; },
      deepcopy: (value: any) => this.deepcopy(value),
    };
    return vim;
  }

  private deepcopy(value: any): any {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => this.deepcopy(v));
    if (typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(value)) {
        if (typeof (value as any)[k] !== 'function') out[k] = this.deepcopy((value as any)[k]);
      }
      return out;
    }
    return value;
  }

  private makeIter(value: any): any {
    const shim = this;
    const entries = (v: any): any[] => {
      if (v === null || v === undefined) return [];
      if (Array.isArray(v)) return v.map((item, i) => [i, item]);
      return Object.entries(v);
    };
    const fromEntries = (rows: any[]): any => {
      const isIndexed = rows.every(([k]) => typeof k === 'number' || /^\d+$/.test(String(k)));
      if (isIndexed) {
        const sorted = [...rows].sort((a, b) => Number(a[0]) - Number(b[0]));
        return sorted.map(([k, v]) => v);
      }
      const out: Record<string, any> = {};
      for (const [k, v] of rows) out[String(k)] = v;
      return out;
    };
    const iter: any = { value };
    const self = new Proxy(iter, {
      get(t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'value') return t.value;
        switch (prop) {
          case 'filter': return (f: any) => {
            const rows = entries(t.value).filter(([k, v]) => shim.truthy(f(v, k)));
            t.value = fromEntries(rows);
            return self;
          };
          case 'map': return (f: any) => {
            const rows = entries(t.value).map(([k, v]) => [k, f(v, k)]);
            t.value = fromEntries(rows);
            return self;
          };
          case 'flatten': {
            const flat: any[] = [];
            entries(t.value).forEach(([, v]) => {
              if (Array.isArray(v)) flat.push(...v);
              else flat.push(v);
            });
            t.value = flat;
            return self;
          }
          case 'each': return (f: any) => {
            entries(t.value).forEach(([k, v]) => f(v, k));
            return self;
          };
          case 'next': return () => {
            const rows = entries(t.value);
            if (rows.length === 0) { t.value = []; return null; }
            const [, v] = rows[0];
            const rest = rows.slice(1);
            t.value = fromEntries(rest);
            return v;
          };
          case 'totable': return () => t.value;
          case 'tostring': return () => JSON.stringify(t.value);
          default: return undefined;
        }
      },
      set(t, prop, v) { (t as any)[String(prop)] = v; return true; },
    });
    return self;
  }

  private truthy(v: any): boolean {
    if (v === undefined) return false;
    if (v === null) return false;
    if (Array.isArray(v) && v.length === 1 && v[0] === false) return false;
    return !!v;
  }

  private tblDeepExtend(behavior: string, tables: any[]): any {
    const isArr = (v: any) => Array.isArray(v);
    const merge = (target: any, src: any): any => {
      if (src === null || src === undefined) return target;
      if (isArr(target) || isArr(src)) {
        const base = isArr(target) ? [...target] : [];
        if (isArr(src)) base.push(...src);
        else for (const k of Object.keys(src)) base.push(src[k]);
        return base;
      }
      const out = typeof target === 'object' && target !== null ? { ...target } : {};
      for (const k of Object.keys(src)) {
        const sv = (src as any)[k];
        const tv = (out as any)[k];
        const bothObj = tv !== undefined && sv !== null && typeof tv === 'object' && typeof sv === 'object'
          && !Array.isArray(tv) && !Array.isArray(sv);
        if (bothObj && behavior === 'force') (out as any)[k] = merge(tv, sv);
        else if (bothObj && behavior === 'keep' && Object.keys(tv).length === 0) (out as any)[k] = { ...sv };
        else if (bothObj) (out as any)[k] = merge(tv, sv);
        else if (behavior !== 'keep') (out as any)[k] = sv;
      }
      return out;
    };
    let out: any = {};
    for (const t of tables) {
      if (t === null || t === undefined) continue;
      out = merge(out, t);
    }
    return out;
  }

  private tblExtend(behavior: string, tables: any[]): any {
    let out: any = {};
    for (const t of tables) {
      if (t === null || t === undefined) continue;
      const o = itAsObj(t);
      if (behavior === 'keep') {
        for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k];
      } else {
        out = { ...out, ...o };
      }
    }
    return out;
  }

  optRead(name: string): any {
    return decorateProxy(new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        const p = String(prop);
        switch (p) {
          case 'get': case 'value': case '_value':
            return () => this.optionGet(name);
          case 'set': case 'override': case 'append': case 'prepend': case 'remove':
            return (value?: any) => this.optMethod(name, p, value);
          default:
            return this.optionGet(name);
        }
      },
      set: (_t, _prop, value) => { this.optionSet(name, value); return true; },
    }), { proxy: true });
  }

  optMethod(name: string, method: string, value?: any): any {
    const current = this.optionGet(name);
    switch (method) {
      case 'set': this.optionSet(name, value); return value;
      case 'override': this.optionSet(name, value); return value;
      case 'append': {
        const arr = toArr(current);
        arr.push(value);
        this.optionSet(name, serializeList(arr));
        return;
      }
      case 'prepend': {
        const arr = toArr(current);
        arr.unshift(value);
        this.optionSet(name, serializeList(arr));
        return;
      }
      case 'remove': {
        const arr = toArr(current).filter((x) => x !== value);
        this.optionSet(name, serializeList(arr));
        return;
      }
      default: return current;
    }
  }

  wait(ms: number, cond?: any, cb?: any) {
    const start = Date.now();
    while (Date.now() - start < (ms || 0)) {
      if (typeof cond === 'function') {
        let ok = false;
        try { ok = !!cond(); } catch { /* ignore */ }
        if (ok) {
          if (typeof cb === 'function') { try { cb(); } catch { /* ignore */ } }
          return LuaMultiReturn.of(true, 'ok');
        }
      }
    }
    if (typeof cb === 'function') { try { cb(); } catch { /* ignore */ } }
    return LuaMultiReturn.of(false, 'timeout');
  }

  translateKeycodes(lhs: string): string {
    let out = '';
    let rest = lhs;
    const specials: Record<string, string> = {
      cr: 'Enter', enter: 'Enter', return: 'Enter', tab: 'Tab',
      esc: 'Escape', bs: 'Backspace', backspace: 'Backspace', space: ' ',
      up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    };
    while (rest.length) {
      const m = /^<([^>]*)>/.exec(rest);
      if (!m) {
        out += rest[0];
        rest = rest.slice(1);
        continue;
      }
      const inner = m[1].toLowerCase();
      let mapped: string | null = null;
      if (inner === 'leader') mapped = 'leader';
      else if (inner.startsWith('c-s-')) mapped = 'Ctrl-' + inner.slice(4).toUpperCase();
      else if (inner.startsWith('c-')) mapped = 'Ctrl-' + inner.slice(2).toUpperCase().toLowerCase();
      else if (inner.startsWith('a-')) mapped = 'Alt-' + inner.slice(2);
      else if (inner.startsWith('s-')) mapped = inner.slice(2).toUpperCase();
      else mapped = specials[inner] ?? null;
      out += mapped ?? m[0];
      rest = rest.slice(m[0].length);
    }
    return out;
  }

  inspect(value: any): string {
    const seen = new WeakSet();
    const rec = (v: any): string => {
      if (v === undefined) return 'nil';
      if (v === null) return 'nil';
      const t = typeof v;
      if (t === 'string') return JSON.stringify(v);
      if (t === 'number' || t === 'boolean') return String(v);
      if (t === 'function') return 'function: inspect';
      if (Array.isArray(v)) {
        if (seen.has(v)) return '{ <cycle> }';
        seen.add(v);
        return '{ ' + v.map((x) => rec(x)).join(', ') + ' }';
      }
      if (t === 'object') {
        if (seen.has(v)) return '{ <cycle> }';
        seen.add(v);
        const entries = Object.keys(v)
          .filter((k) => typeof (v as any)[k] !== 'function')
          .map((k) => `[${JSON.stringify(k)}] = ${rec((v as any)[k])}`);
        return entries.length ? '{ ' + entries.join(', ') + ' }' : '{}';
      }
      return String(v);
    };
    return rec(value);
  }

  private makeVimCmd(): any {
    const execute = (input: any) => {
      if (typeof input === 'function') { input(); return; }
      if (input && typeof input === 'object') {
        const name = input.cmd || input.name || (Array.isArray(input) ? input[0] : '');
        const args = (input.args || []).join(' ');
        this.backend.executeCommand(`${name}${args ? ' ' + args : ''}`);
        return;
      }
      this.backend.executeCommand(String(input ?? ''));
    };
    const fn: any = execute;
    const proxy: any = new Proxy(fn, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        const name = String(prop);
        return (...args: any[]) => {
          const literals = args.filter((a) => typeof a === 'string');
          this.backend.executeCommand(`${name} ${literals.join(' ')}`.trim());
        };
      },
    });
    return decorateProxy(proxy, { proxy: true });
  }

  private buildNvimAPI(): Record<string, any> {
    const state = this.state;

    const api: Record<string, any> = {};

    // ---- Buffers / editor state ---------------------------------------
    api.nvim_get_current_buf = () => 1;
    api.nvim_get_current_buffers = () => [1];
    api.nvim_buf_get_number = () => 1;
    api.nvim_buf_is_valid = () => true;
    api.nvim_buf_is_loaded = () => true;
    api.nvim_buf_get_name = () => this.backend.getCurrentFilePath() ?? '';
    api.nvim_buf_set_name = (_b: number, name: string) => {
      const fs = this.backend.fs;
      if (!fs || !name) return null;
      return fs.writeFile(name, this.backend.getBuffer().join('\n')).catch(() => {});
    };
    api.nvim_buf_get_lines = (_b: number, start: number, end: number, _strict: boolean) => {
      const lines = this.backend.getBuffer();
      let s = Math.max(0, start);
      let e = end === -1 ? lines.length : Math.max(s, end);
      return lines.slice(s, e);
    };
    api.nvim_buf_set_lines = (_b: number, start: number, end: number, _strict: boolean, lines?: string[]) => {
      const cur = [...this.backend.getBuffer()];
      let s = Math.max(0, start);
      const e = end === -1 ? cur.length : Math.max(s, end);
      const replacement = lines && lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.slice(0, -1)
        : (lines ?? []);
      cur.splice(s, e - s, ...replacement);
      this.backend.setBuffer(cur);
    };
    api.nvim_buf_get_offset = (_b: number, index: number) => {
      const lines = this.backend.getBuffer();
      let count = 0;
      for (let i = 0; i < index && i < lines.length; i++) count += lines[i].length + 1;
      return count;
    };
    api.nvim_get_current_line = () => {
      const c = this.backend.getCursor();
      return this.backend.getBuffer()[c.y] ?? '';
    };
    api.nvim_set_current_line = (line: string) => {
      const c = this.backend.getCursor();
      const cur = [...this.backend.getBuffer()];
      cur[c.y] = line;
      this.backend.setBuffer(cur);
    };
    api.nvim_get_current_cursor = () => {
      const c = this.backend.getCursor();
      return [c.y + 1, c.x];
    };
    api.nvim_win_get_cursor = () => api.nvim_get_current_cursor();
    api.nvim_win_set_cursor = (_w: number, pos?: any[]) => {
      const [row, col] = pos ?? [1, 0];
      this.backend.setCursor(col ?? 0, Math.max(0, (row ?? 1) - 1));
    };
    api.nvim_win_get_number = () => 1;
    api.nvim_get_current_win = () => 1;
    api.nvim_get_current_tabpage = () => 1;
    api.nvim_win_get_buf = () => 1;
    api.nvim_tabpage_get_number = () => 1;
    api.nvim_tabpage_get_win = () => 1;
    api.nvim_get_mode = () => ({ mode: this.backend.getMode().toLowerCase(), blocking: false });
    api.nvim_set_current_dir = () => {};

    // ---- Options / variables -------------------------------------------
    api.nvim_get_option = (name: string) => this.optionGet(String(name));
    api.nvim_set_option = (name: string, value: any) => this.optionSet(String(name), value);
    api.nvim_get_option_value = (name: string) => this.optionGet(String(name));
    api.nvim_set_option_value = (name: string, value: any) => this.optionSet(String(name), value);
    api.nvim_get_vvar = (name: string) => state.vVars[name];
    api.nvim_set_vvar = (name: string, value: any) => { state.vVars[name] = value; };
    api.nvim_get_var = (name: string) => state.vars[name];
    api.nvim_set_var = (name: string, value: any) => {
      if (name === 'mapleader') this.optionSet(name, value);
      else state.vars[name] = value;
    };
    api.nvim_del_var = (name: string) => { delete state.vars[name]; };
    api.nvim_get_bvar = (_b: number, name: string) => state.bufVars[1]?.[name];
    api.nvim_set_bvar = (_b: number, name: string, value: any) => { state.bufVars[1][name] = value; };
    api.nvim_del_bvar = (_b: number, name: string) => { delete state.bufVars[1][name]; };
    api.nvim_get_wvar = (_w: number, name: string) => state.winVars[1]?.[name];
    api.nvim_set_wvar = (_w: number, name: string, value: any) => { state.winVars[1][name] = value; };
    api.nvim_del_wvar = (_w: number, name: string) => { delete state.winVars[1][name]; };

    // ---- Output ----------------------------------------------------------
    api.nvim_out_write = (msg: string) => console.log('[vim.out_write]', String(msg));
    api.nvim_err_write = (msg: string) => console.error(String(msg));
    api.nvim_echo = () => {};
    api.nvim_notify = (msg: string) => { console.log('[vim.notify]', String(msg)); };

    // ---- Commands ----------------------------------------------------------
    api.nvim_command = (cmd: string) => this.backend.executeCommand(String(cmd));
    api.nvim_exec = (cmd: string, _output: boolean) => {
      String(cmd).split('\n').forEach((line) => {
        const t = line.trim();
        if (t) this.backend.executeCommand(t);
      });
      return '';
    };
    api.nvim_exec2 = (cmd: string, _opts?: any) => ({ output: api.nvim_exec(cmd, true) });
    api.nvim_create_user_command = (name: string, callback: any, opts?: any) => {
      const n = String(name);
      if (typeof callback === 'string') {
        this.backend.registerCommand(n, () => this.backend.executeCommand(callback));
        return;
      }
      this.backend.registerCommand(n, (args: string[]) => {
        if (typeof callback === 'function') {
          callback({ name: n, args: args.join(' '), fargs: args, range: !!(opts && opts.range) });
        }
      });
    };
    api.nvim_del_user_command = (name: string) => this.backend.delCommand(String(name));

    // ---- Autocmds ---------------------------------------------------------
    api.nvim_create_augroup = (name: string, opts?: any) => {
      if ((opts && opts.clear) || !state.augroups.has(name)) {
        if (state.augroups.has(name) && opts && opts.clear) {
          const existing = state.augroups.get(name);
          state.autocmds.forEach((a, id) => { if (a.group === existing) state.autocmds.delete(id); });
        }
        state.autocmdCounter++;
        state.augroups.set(name, state.autocmdCounter);
      }
      return state.augroups.get(name)!;
    };
    api.nvim_del_augroup_by_id = (id: number) => {
      state.autocmds.forEach((a, k) => { if (a.group === id) state.autocmds.delete(k); });
    };
    api.nvim_del_augroup_by_name = (name: string) => {
      const id = state.augroups.get(name);
      if (id !== undefined) api.nvim_del_augroup_by_id(id);
    };
    api.nvim_clear_autocmds = (opts?: any) => {
      const group = opts && opts.group;
      state.autocmds.forEach((a, id) => {
        if (group !== undefined && a.group !== group) return;
        state.autocmds.delete(id);
      });
    };
    api.nvim_create_autocmd = (events: any, opts?: any) => {
      const evs = Array.isArray(events) ? events : [events];
      const cb = opts && opts.callback;
      if (typeof cb !== 'function') return -1;
      state.autocmdCounter++;
      const id = state.autocmdCounter;
      const group = opts && opts.group;
      const pattern = opts && opts.pattern
        ? (Array.isArray(opts.pattern) ? opts.pattern.map(String) : [String(opts.pattern)])
        : undefined;
      const rec = { events: evs.map(String), group, pattern, cb };
      state.autocmds.set(id, rec);

      const mapped: string[] = [];
      evs.forEach((ev) => {
        const me = toEngineEvent(String(ev));
        if (me && !mapped.includes(me)) mapped.push(me);
      });
      const handler = (...args: any[]) => {
        const data = args?.[0] ?? {};
        const file = data.path ?? this.backend.getCurrentFilePath();
        try {
          cb({ id, event: rec.events[0], buf: 1, match: file ?? '', group, data: {}, matches: () => true });
        } catch (err) {
          console.error('[vim.api] autocmd callback error:', err);
        }
      };
      mapped.forEach((me) => this.backend.on(me, handler));
      return id;
    };
    api.nvim_del_autocmd = (id: number) => {
      state.autocmds.delete(id);
    };
    api.nvim_exec_autocmds = (events: any, _opts?: any) => {
      state.autocmds.forEach((a) => {
        if (a.events.includes(String(events))) {
          try { a.cb({ id: 0, event: String(events), buf: 1, match: '' }); } catch (err) { console.error(err); }
        }
      });
    };

    // ---- Namespaces / extmarks -----------------------------------------
    api.nvim_create_namespace = (name?: string) => {
      state.namespaceCounter++;
      state.namespaces.set(state.namespaceCounter, String(name || ''));
      return state.namespaceCounter;
    };
    api.nvim_get_namespaces = () => {
      const out: Record<string, number> = {};
      state.namespaces.forEach((name, id) => { if (name) out[name] = id; });
      return out;
    };
    api.nvim_buf_set_extmark = (_b: number, ns: number, line: number, col: number, opts?: any) => {
      const o = opts ? (Array.isArray(opts) ? opts[0] || {} : opts) : {};
      const key = `${ns}`;
      if (!state.extmarks.has(key)) state.extmarks.set(key, []);
      state.extmarks.get(key)!.push({ ns, line, col, opts: o || {} });
      return (state.extmarks.get(key)!.length) - 1;
    };
    api.nvim_buf_del_extmark = (_b: number, ns: number, id: number) => {
      const arr = state.extmarks.get(`${ns}`);
      if (arr && arr[id]) { arr[id] = undefined as any; }
    };
    api.nvim_buf_clear_namespace = (_b: number, ns: number) => {
      state.extmarks.delete(`${ns}`);
    };
    api.nvim_buf_get_extmarks = (_b: number, ns: number) => {
      return (state.extmarks.get(`${ns}`) ?? []).filter(Boolean).map((e, idx) =>
        [e.line, e.col, idx, `ns_${e.ns}`] as any
      );
    };

    // ---- Termcodes -------------------------------------------------------
    api.nvim_replace_termcodes = (s: string, _a?: any, _b?: any, _c?: any) => this.translateKeycodes(String(s ?? ''));
    api.nvim_list_uis = () => [{ rgb: true, ext_multigrid: false, ext_popupmenu: false, ext_linegrid: true }];
    api.get_keymaps = () => [];

    return api;
  }

  private buildKeymap(): Record<string, any> {
    const shim = this;
    return {
      set: (mode: string, lhs: string, rhs: any, _opts?: any) => {
        const m = String(mode);
        const key = shim.translateKeycodes(String(lhs));
        if (typeof rhs === 'function') {
          shim.backend.registerKeymap(m, key, rhs as KeymapCallback);
        } else if (typeof rhs === 'string') {
          const cmd = rhs.startsWith(':') ? rhs.slice(1) : rhs.replace(/^<cmd>/, '').replace(/<CR>$/i, '');
          shim.backend.registerKeymap(m, key, () => shim.backend.executeCommand(cmd));
        }
      },
      del: (mode: string, lhs: string) => {
        shim.backend.delKeymap(String(mode), shim.translateKeycodes(String(lhs)));
      },
      clear: (mode?: string) => {
        shim.backend.delKeymap(String(mode ?? ''), '');
      },
    };
  }

  private buildFn(): any {
    const shim = this;
    return decorateProxy(new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        const name = String(prop);
        return (...args: any[]) => shim.fnCall(name, args);
      },
    }), { proxy: true });
  }

  private fnCall(name: string, args: any[]): any {
    for (const group of [FUNCS_CORE, FUNCS_EXTRA]) {
      const fn = (group as any)[name];
      if (fn) return fn(this.backend, args);
    }
    console.warn(`[vim.fn] unimplemented function: ${name}`);
    return null;
  }

  private buildFS(): any {
    const shim = this;
    const fsWrap = {
      basename: (p: any) => String(p).split('/').pop() || '',
      dirname: (p: any) => {
        const parts = String(p).split('/');
        parts.pop();
        return parts.join('/');
      },
      joinpath: (...parts: any[]) => parts.filter((p) => p !== null && p !== undefined).map(String).join('/'),
      norm: (p: any) => String(p).replace(/\/+/g, '/').replace(/\/$/, ''),
      separator: () => '/',
      exists: (p: any) => {
        const fs = shim.backend.fs;
        return fs ? fs.readFile(String(p)).then((c: string | null) => c !== null) : Promise.resolve(false);
      },
      read: (p: any) => {
        const fs = shim.backend.fs;
        return fs ? fs.readFile(String(p)) : Promise.resolve(null);
      },
      write: (p: any, content: any) => {
        const fs = shim.backend.fs;
        return fs ? fs.writeFile(String(p), String(content)) : Promise.resolve();
      },
      stat: (p: any) => {
        const fs = shim.backend.fs;
        return fs ? fs.readFile(String(p)).then((c: string | null) => (c === null ? null : { type: 'file', size: c.length })) : Promise.resolve(null);
      },
      find: (p: any) => {
        const fs = shim.backend.fs;
        return fs ? fs.readFile(String(p)).then((c: string | null) => (c === null ? [] : [String(p)])) : Promise.resolve([]);
      },
    };
    return decorateProxy(new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        const name = String(prop);
        return (fsWrap as any)[name] ?? ((..._args: any[]) => { console.warn(`[vim.fs] unimplemented: ${name}`); return null; });
      },
    }), { proxy: true });
  }
}

function toArr(value: any): any[] {
  if (Array.isArray(value)) return [...value];
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') return value.split(',').map((s) => s.trim());
  return [value];
}

function itAsObj(v: any): Record<string, any> {
  if (v === null || v === undefined) return {};
  if (Array.isArray(v)) {
    const o: Record<string, any> = {};
    v.forEach((item, i) => { o[i] = item; });
    return o;
  }
  return v;
}

function serializeList(arr: any[]): any {
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return arr.join(',');
}

const FUNCS_CORE: Record<string, (backend: LuaBackend, args: any[]) => any> = {
  expand: (b, args) => {
    const what = String(args[0] ?? '');
    const fname = b.getCurrentFilePath();
    if (what.includes('%')) return fname ?? '';
    if (what.includes('#')) return fname ?? '';
    return '';
  },
  fnamemodify: (_b, args) => {
    let p = String(args[0] ?? '');
    const mods = String(args[1] ?? '');
    if (mods.includes(':h')) p = p.split('/').slice(0, -1).join('/');
    if (mods.includes(':t')) p = p.split('/').pop() || '';
    if (mods.includes(':e')) p = p.includes('.') ? p.split('.').pop()! : '';
    if (mods.includes(':p')) p = '/' + p;
    return p;
  },
  empty: (_b, args) => (args[0] === undefined || args[0] === null || args[0] === '' ? 1 : 0),
  exists: (_b, args) => (typeof args[0] === 'function' ? 1 : (args[0] === undefined || args[0] === null ? 0 : 1)),
  type: (_b, args) => {
    const v = args[0];
    if (v === undefined || v === null) return 'v:nil';
    if (typeof v === 'function') return 'v:t_func';
    if (Array.isArray(v)) return 'v:list';
    if (typeof v === 'object') return 'v:dict';
    if (typeof v === 'number') return 'v:number';
    if (typeof v === 'string') return 'v:string';
    if (typeof v === 'boolean') return 'v:bool';
    return 'v:none';
  },
  has: (_b, args) => {
    const f = String(args[0] ?? '');
    const present = {
      nvim: 1, lua: 1, timers: 1, unix: 1, linux: 1, 'net-vim': 1,
      'nvim-0.5': 1, 'nvim-0.6': 1, 'nvim-0.7': 1, 'nvim-0.8': 1, 'nvim-0.9': 1, 'nvim-0.10': 1,
    };
    if (f.startsWith('nvim-')) return 1;
    return (present as any)[f] ?? 0;
  },
  strftime: () => '',
  resolve: (_b, args) => String(args[0] ?? ''),
  substitute: (_b, args) => {
    const s = String(args[0] ?? '');
    const pat = String(args[1] ?? '');
    const rep = String(args[2] ?? '');
    try { return s.replace(new RegExp(pat, 'g'), rep); } catch { return s; }
  },
  trim: (_b, args) => String(args[0] ?? '').trim(),
  tolower: (_b, args) => String(args[0] ?? '').toLowerCase(),
  toupper: (_b, args) => String(args[0] ?? '').toUpperCase(),
};

const FUNCS_EXTRA: Record<string, (backend: LuaBackend, args: any[]) => any> = {
  getcwd: () => '',
  bufname: (b, args) => {
    const name = b.getCurrentFilePath();
    const nr = args[0];
    if (nr === 0 || nr === 1) return name ?? '';
    return '';
  },
  line: (b, args) => {
    const what = args[0];
    if (what === '.') return b.getCursor().y + 1;
    if (what === 'w0') return 1;
    return 1;
  },
  col: (_b, args) => {
    if (args[0] === '.') return 0;
    return 0;
  },
  synIDtrans: (_b, args) => args[0] ?? 0,
  setreg: () => 0,
  getregtype: () => 'v',
  mode: (b) => b.getMode().toLowerCase(),
  strchars: (_b, args) => String(args[0] ?? '').length,
  len: (_b, args) => (Array.isArray(args[0]) ? args[0].length : typeof args[0] === 'string' ? args[0].length : 0),
  max: (_b, args) => Math.max(...(Array.isArray(args[0]) ? args[0] : args.map(Number))),
  min: (_b, args) => Math.min(...(Array.isArray(args[0]) ? args[0] : args.map(Number))),
  sort: (_b, args) => {
    const input = Array.isArray(args[0]) ? args[0] : [];
    const func = args[1];
    if (typeof func === 'function') {
      return [...input].sort((a, b) => { const r = func(a, b); return r && r[0] === 1 ? -1 : 1; });
    }
    return [...input].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  },
  printf: (_b, args) => {
    const fmt = String(args[0] ?? '');
    const values = args.slice(1);
    let i = 0;
    return fmt.replace(/%[sdqg]/g, () => String(values[i++]));
  },
  system: () => '',
};

export function createVimShim(backend: LuaBackend, moduleLoader: LuaModuleLoader): VimShim {
  return new VimShim(backend, moduleLoader);
}

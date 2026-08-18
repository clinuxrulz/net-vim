import { h } from '../../solid-universal-tui';
import { BufferTreeParser, type BaseTreeParser } from './parser';
import { TreesitterQuery } from './query';
import { extToLang, type LanguageLoader } from './language';
import { getDefaultHighlights } from './queries';
import type { LuaBackend } from '../backend';

export interface HighlightContext {
  backend: LuaBackend;
  registerLineRenderer: (opts: any) => void;
  rerender?: () => void;
  readQueryFile?: (lang: string) => Promise<string | null>;
}

interface Segment {
  start: number;
  end: number;
  color: string;
}

const DEFAULT_COLOR = '#d4d4d4';

const SCHEME: Record<string, string> = {
  comment: '#6a9955',
  string: '#ce9178',
  number: '#b5cea8',
  keyword: '#569cd6',
  function: '#dcdcaa',
  method: '#dcdcaa',
  type: '#4ec9b0',
  variable: '#9cdcfe',
  field: '#9cdcfe',
  property: '#9cdcfe',
  constant: '#4fc1ff',
  operator: '#d4d4d4',
  preproc: '#c586c0',
  include: '#c586c0',
  decorator: '#c586c0',
  namespace: '#dcdcaa',
  label: '#dcdcaa',
  title: '#4ec9b0',
  punctuation: '#d4d4d4',
  parameter: '#9cdcfe',
  constructor: '#4ec9b0',
  tag: '#569cd6',
  attribute: '#9cdcfe',
  bool: '#4fc1ff',
  identifier: '#d4d4d4',
};

export function captureColor(capture: string): string {
  if (!capture) return DEFAULT_COLOR;
  const parts = capture.split('.');
  for (let i = parts.length; i > 0; i--) {
    const key = parts.slice(0, i).join('.');
    if (SCHEME[key]) return SCHEME[key];
  }
  if (SCHEME[parts[0]]) return SCHEME[parts[0]];
  return DEFAULT_COLOR;
}

export class TreeSitterHighlighter {
  private ctx: HighlightContext;
  private loader: LanguageLoader;
  private queries = new Map<string, TreesitterQuery>();
  private parses = new Map<number, { parser: BufferTreeParser; source: string }>();
  private lastRb: Map<string, string> = new Map();
  readonly active = new Map<number, { buf: number; lang: string }>();
  private rendererRegistered = false;
  private textChangedSubscribed = false;

  constructor(ctx: HighlightContext, loader: LanguageLoader) {
    this.ctx = ctx;
    this.loader = loader;
  }

  private getLangForBuf(bufnr: number): string | null {
    const path = this.ctx.backend.getCurrentFilePath();
    return extToLang(path ?? '');
  }

  start(bufnr: number | null | undefined, lang?: string) {
    const buf = normalizeBuf(bufnr);
    const resolvedLang = (lang && String(lang)) || this.getLangForBuf(buf) || '';
    if (!resolvedLang) return false;
    const language = this.loader.getSync(resolvedLang);
    if (!language) {
      this.loader.get(resolvedLang).catch(() => {});
      console.warn(`[vim.treesitter] grammar '${resolvedLang}' not yet loaded`);
      return false;
    }
    this.active.set(buf, { buf, lang: resolvedLang });
    this.ensureRenderer();
    this.ensureTextChanged();
    if (this.ctx.rerender) this.ctx.rerender();
    return true;
  }

  stop(bufnr: number | null | undefined) {
    this.active.delete(normalizeBuf(bufnr));
    if (this.ctx.rerender) this.ctx.rerender();
  }

  getActive(bufnr: number | null | undefined): any {
    return this.active.get(normalizeBuf(bufnr)) ?? null;
  }

  /** List of { capture, node } at a given (row, byte-col) position. */
  capturesAt(bufnr: number, row: number, col: number): any[] {
    const entry = this.active.get(normalizeBuf(bufnr)) ?? this.active.get(1);
    if (!entry) return [];
    const language = this.loader.getSync(entry.lang);
    if (!language) return [];
    const parser = this.parserFor(entry.lang, language);
    if (!parser) return [];
    const q = this.queryFor(entry.lang, language, parser);
    if (!q) return [];
    const root = parser.wrapNode(parser.getTree()?.rootNode);
    if (!root) return [];
    const entries = q.parseCaptureList(root, Math.max(0, row - 1), row + 1);
    const out: any[] = [];
    for (const e of entries) {
      const node = e.node;
      if (!node || typeof node.range !== 'function') continue;
      const [sr, sc, er, ec] = node.range();
      const afterStart = sr < row || (sr === row && sc <= col);
      const beforeEnd = er > row || (er === row && ec >= col);
      if (afterStart && beforeEnd) {
        out.push({ capture: e.name, node });
      }
    }
    return out;
  }

  private ensureTextChanged() {
    if (this.textChangedSubscribed) return;
    this.textChangedSubscribed = true;
    this.ctx.backend.on('TextChanged', () => {
      const source = this.source();
      for (const [buf, rec] of this.parses) {
        if (rec.source !== source) {
          this.parses.delete(buf);
        }
      }
      if (this.ctx.rerender) this.ctx.rerender();
    });
  }

  private source(): string {
    return this.ctx.backend.getBuffer().join('\n');
  }

  private ensureRenderer() {
    if (this.rendererRegistered) return;
    this.rendererRegistered = true;
    this.ctx.registerLineRenderer({
      name: 'treesitter-highlighter',
      priority: 30,
      render: (props: any) => this.renderLine(props),
    });
  }

  private resolve(getter: any): any {
    return typeof getter === 'function' ? getter() : getter;
  }

  private renderLine(props: any): any | null {
    const activeEntry = this.active.get(1) ?? this.active.get(0);
    if (!activeEntry) return null;
    const kind = activeEntry.lang;
    const language = this.loader.getSync(kind);
    if (!language) return null;

    const parser = this.parserFor(kind, language);
    if (!parser) return null;

    const q = this.queryFor(kind, language, parser);
    if (!q) return null;

    const lineIndex = this.resolve(props.lineIndex);
    const lineContent = this.resolve(props.lineContent) ?? '';
    const leftCol = this.resolve(props.leftCol) ?? 0;
    const viewportWidth = this.resolve(props.viewportWidth) ?? 80;

    const segments = this.segmentsForLine(parser, q, lineIndex, lineContent.length);
    if (!segments || segments.length === 0) return null;

    const tokens: any[] = [];
    const visible = [];
    let cursor = 0;
    for (const seg of segments.slice().sort((a, b) => a.start - b.start)) {
      if (seg.start > cursor) {
        visible.push({ start: cursor, end: seg.start, color: DEFAULT_COLOR });
        cursor = seg.start;
      }
      visible.push({ start: seg.start, end: seg.end, color: seg.color });
      cursor = Math.max(cursor, seg.end);
    }
    if (cursor < lineContent.length) {
      visible.push({ start: cursor, end: lineContent.length, color: DEFAULT_COLOR });
    }

    for (const seg of visible) {
      const end = Math.min(seg.end, leftCol + viewportWidth);
      const start = Math.max(seg.start, leftCol);
      if (end <= start) continue;
      const content = lineContent.slice(start, end);
      if (!content) continue;
      tokens.push(h('tui-text', { x: start - leftCol, y: 0, content, color: seg.color }));
    }
    return tokens.length ? tokens : null;
  }

  private parserFor(lang: string, language: any): BufferTreeParser | null {
    const source = this.source();
    const existing = this.parses.get(1);
    if (existing && existing.source === source && existing.parser.lang === lang) {
      return existing.parser;
    }
    const parser = new BufferTreeParser(this.ctx.backend, lang, language);
    parser.parse();
    this.parses.set(1, { parser, source });
    return parser;
  }

  private queryFor(lang: string, language: any, parser: BufferTreeParser): TreesitterQuery | null {
    const key = `${lang}:highlights`;
    if (this.queries.has(key)) return this.queries.get(key)!;
    const q = this.buildQuery(lang, language, parser);
    if (q) this.queries.set(key, q);
    return q;
  }

  private buildQuery(lang: string, language: any, parser: BaseTreeParser): TreesitterQuery | null {
    const TS = (globalThis as any).__netvim_treesitter_module;
    if (!TS) return null;
    const src = getDefaultHighlights(lang);
    if (!src) return null;
    try {
      const query = new TS.Query(language, src);
      return new TreesitterQuery(lang, query, () => parser);
    } catch (err) {
      console.error(`[vim.treesitter] failed to compile ${lang} highlights query:`, err);
      return null;
    }
  }

  private segmentsForLine(parser: BufferTreeParser, q: TreesitterQuery, line: number, textLen: number): Segment[] | null {
    const root = parser.wrapNode(parser.getTree()?.rootNode);
    if (!root) return null;
    const entries = q.parseCaptureList(root, line, line + 1);
    const segs: Segment[] = [];
    for (const entry of entries) {
      const node = entry.node;
      if (!node || typeof node.range !== 'function') continue;
      const [sr, sc, er, ec] = node.range();
      if (sr !== line) continue;
      const color = captureColor(entry.name);
      const start = Math.max(0, sc);
      const end = sr === er ? Math.min(ec, textLen) : textLen;
      if (end <= start) continue;
      segs.push({ start, end, color });
    }
    // Merge overlapping/adjacent segments for cleanliness.
    segs.sort((a, b) => a.start - b.start);
    const merged: Segment[] = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) {
        last.end = Math.max(last.end, s.end);
        last.color = s.color;
      } else {
        merged.push({ ...s });
      }
    }
    return merged;
  }

  invalidateAll() {
    this.parses.clear();
    this.queries.clear();
  }
}

function normalizeBuf(bufnr: number | null | undefined): number {
  if (bufnr === null || bufnr === undefined || bufnr === 0) return 1;
  return bufnr;
}

import { LuaMultiReturn } from 'wasmoon';
import { unwrapNode, type BaseTreeParser } from './parser';

/**
 * Wraps a web-tree-sitter Query for Lua. Exposes Neovim-style methods:
 *   q:iter_captures(root, bufnr, sr, er)  -> for id, node, metadata in ... do
 *   q:iter_matches(root, bufnr, sr, er)   -> for match, id in ... do
 *   q:matches(node, sr, er)
 *   q:captures, q:capture_count(), q:pattern_count()
 */
export class TreesitterQuery {
  readonly lang: string;
  private query: any;
  private parserFactory: (lang: string) => BaseTreeParser | null;

  constructor(lang: string, query: any, parserFactory: (lang: string) => BaseTreeParser | null) {
    this.lang = lang;
    this.query = query;
    this.parserFactory = parserFactory;
  }

  get captures(): string[] {
    return this.query.captureNames ?? [];
  }

  capture_count() {
    return this.captures.length;
  }

  pattern_count() {
    return this.query.patternCount();
  }

  captureIndexForName(name: string): number {
    const idx = this.query.captureIndexForName(name);
    return idx == null ? -1 : idx + 1;
  }

  private optsFor(start?: number, stop?: number) {
    const opts: any = {};
    if (start != null && stop != null) {
      opts.startPosition = { row: start, column: 0 };
      opts.endPosition = { row: stop, column: 0 };
    }
    return opts;
  }

  private parserForLang(): BaseTreeParser | null {
    return this.parserFactory(this.lang);
  }

  parseCaptureList(node: any, start?: number, stop?: number): any[] {
    const raw = unwrapNode(node);
    if (!raw) return [];
    const captures = this.query.captures(raw, this.optsFor(start, stop));
    const parser = this.parserForLang();
    return captures.map((c: any) => {
      const nodeWrapper = parser ? parser.wrapNode(c.node) : null;
      const captureId = (this.query.captureIndexForName(c.name) ?? -1) + 1;
      return { capture_id: captureId, name: c.name, node: nodeWrapper };
    });
  }

  matchList(node: any, start?: number, stop?: number): any[] {
    const raw = unwrapNode(node);
    if (!raw) return [];
    const matches = this.query.matches(raw, this.optsFor(start, stop));
    const parser = this.parserForLang();
    return matches.map((m: any) => {
      const captures: any[] = [];
      for (const c of m.captures ?? []) {
        const id = (this.query.captureIndexForName(c.name) ?? -1) + 1;
        captures[id - 1] = parser ? parser.wrapNode(c.node) : null;
      }
      return {
        pattern: m.patternIndex + 1,
        metadata: m.setProperties ? { ...m.setProperties } : {},
        captures,
      };
    });
  }

  /**
   * Return an iterator closure for Lua generic-for. Yields:
   *   (captureId, nodeWrapper, metadata)
   */
  iter_captures(node: any, _bufnr: number, start?: number, stop?: number) {
    const list = this.parseCaptureList(node, start, stop);
    let i = 0;
    const iter = function () {
      if (i >= list.length) return LuaMultiReturn.of();
      const entry = list[i++];
      return LuaMultiReturn.of(entry.capture_id, entry.node, {});
    };
    return iter;
  }

  /**
   * Return an iterator closure for Lua generic-for. Yields:
   *   (matchTable, patternIndex)
   */
  iter_matches(node: any, _bufnr: number, start?: number, stop?: number) {
    const list = this.matchList(node, start, stop);
    let i = 0;
    const iter = function () {
      if (i >= list.length) return LuaMultiReturn.of();
      const entry = list[i++];
      return LuaMultiReturn.of(entry, entry.pattern);
    };
    return iter;
  }

  matches(node: any, start?: number, stop?: number) {
    return this.matchList(node, start, stop);
  }
}

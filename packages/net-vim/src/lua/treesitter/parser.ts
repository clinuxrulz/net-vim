import { decorateProxy, LuaMultiReturn } from 'wasmoon';

export interface ParserBackendSource {
  getBuffer(): string[];
}

/**
 * Base wrapper holding a web-tree-sitter parser plus a node identity cache.
 * Nodes are cached by `id` per (parser, tree) so `==` between nodes from the
 * same parse works by reference identity.
 */
export abstract class BaseTreeParser {
  readonly lang: string;
  protected rawParser: any = null;
  protected language: any = null;
  protected tree: any = null;
  protected nodeCache: Map<number, any> = new Map();
  protected sourceText = '';

  constructor(lang: string) {
    this.lang = lang;
  }

  pointToLua(p: any) {
    return { row: p.row, col: p.column };
  }

  getRawParser() {
    return this.rawParser;
  }

  getTree() {
    return this.tree;
  }

  invalidate() {
    this.nodeCache = new Map();
    this.tree = null;
  }

  /** Create (and cache) the Lua-facing wrapper for a raw web-tree-sitter node. */
  wrapNode(raw: any): any {
    if (!raw) return null;
    const cached = this.nodeCache.get(raw.id);
    if (cached) return cached;
    const node = makeNode(raw, this);
    registerRawNode(raw.id, raw);
    this.nodeCache.set(raw.id, node);
    return node;
  }

  makeTree(): any {
    const tree = this.tree;
    if (!tree) return null;
    return decorateProxy({
      root: () => this.wrapNode(tree.rootNode),
      lang: () => this.lang,
    }, { proxy: true });
  }

  /** Number of lines in the parsed source (used for highlights iteration). */
  getLineCount(): number {
    return this.sourceText ? this.sourceText.split('\n').length : 0;
  }

  getSource(): string {
    return this.sourceText;
  }
}

function makeNode(raw: any, parser: BaseTreeParser): any {
  const node: Record<string, any> = {};
  const point = (p: any) => parser.pointToLua(p);
  const wrap = (n: any) => parser.wrapNode(n);

  node.id = function () { return raw.id; };
  node.type = function () { return raw.type; };
  node.grammar_type = function () { return raw.grammarType ?? raw.type; };
  node.text = function () { return raw.text; };
  node.equals = function (other: any) {
    return !!other && !!other.__raw && raw.id === other.__raw.id;
  };

  node.start = function () {
    const p = point(raw.startPosition);
    return LuaMultiReturn.of(p.row, p.col);
  };
  node.end_ = function () {
    const p = point(raw.endPosition);
    return LuaMultiReturn.of(p.row, p.col);
  };
  node.range = function () {
    const s = point(raw.startPosition);
    const e = point(raw.endPosition);
    return LuaMultiReturn.of(s.row, s.col, e.row, e.col);
  };
  node.start_pos = function () { return point(raw.startPosition); };
  node.end_pos = function () { return point(raw.endPosition); };

  node.child_count = () => raw.childCount;
  node.named_child_count = () => raw.namedChildCount;
  node.child = (i: number) => wrap(raw.child(i));
  node.named_child = (i: number) => wrap(raw.namedChild(i));
  node.field = (name: string) => wrap(raw.childForFieldName(name));
  node.field_name_at_child = (i: number) => raw.fieldNameForChild(i) ?? null;

  node.parent = () => wrap(raw.parent);
  node.first_child = () => wrap(raw.firstChild);
  node.last_child = () => wrap(raw.lastChild);
  node.first_named_child = () => wrap(raw.firstNamedChild);
  node.last_named_child = () => wrap(raw.lastNamedChild);
  node.next_sibling = () => wrap(raw.nextSibling);
  node.prev_sibling = () => wrap(raw.previousSibling);
  node.next_named_sibling = () => wrap(raw.nextNamedSibling);
  node.prev_named_sibling = () => wrap(raw.previousNamedSibling);

  node.has_error = () => !!raw.hasError;
  node.has_changes = () => !!raw.hasChanges;
  node.is_error = () => !!raw.isError;
  node.is_missing = () => !!raw.isMissing;
  node.is_named = () => !!raw.isNamed;
  node.is_extra = () => !!raw.isExtra;
  node.has_grandchildren = () => (raw.childCount > 0 && !!raw.firstChild && raw.firstChild.childCount > 0);

  node.descendant_for_range = function (sr: number, _sc: number, _er: number, _ec: number) {
    return wrap(raw.namedDescendantForPosition({ row: sr, column: 0 }));
  };
  node.descendant_for_index = function (s: number, _e: number) {
    return wrap(raw.descendantForIndex(s));
  };
  node.named_descendant_for_index = function (s: number, _e: number) {
    return wrap(raw.namedDescendantForIndex(s));
  };
  node.descendant_for_position = function (pos: any) {
    if (pos && typeof pos === 'object') {
      const row = pos.row ?? pos[1] ?? 0;
      const col = pos.col ?? pos[2] ?? 0;
      return wrap(raw.descendantForPosition({ row, column: col }));
    }
    return null;
  };
  node.named_descendant_for_pos = function (row: number, col: number) {
    return wrap(raw.namedDescendantForPosition({ row, column: col }));
  };

  node.sexpr = function () {
    try { return raw.toString(); } catch { return raw.type; }
  };

  node.iter_children = function () {
    const out: any[] = [];
    let child = raw.firstChild;
    while (child) {
      out.push(wrap(child));
      child = child.nextSibling;
    }
    return out;
  };

  node.iter_named_children = function () {
    const out: any[] = [];
    let child = raw.firstNamedChild;
    while (child) {
      out.push(wrap(child));
      child = child.nextNamedSibling;
    }
    return out;
  };

  // Keep a reference so Lua-side equality via __raw is possible and helpers
  // (e.g. query results) can unwrap nodes.
  Object.defineProperty(node, '__raw', { value: raw, enumerable: false });

  return node;
}

/** Parser for the editor's current buffer (single buffer backend). */
export class BufferTreeParser extends BaseTreeParser {
  private backend: ParserBackendSource;
  private attempts = 0;

  constructor(backend: ParserBackendSource, lang: string, language: any) {
    super(lang);
    this.backend = backend;
    this.setLanguage(language);
  }

  setLanguage(language: any) {
    const TS = requireParserModule();
    if (!this.rawParser) this.rawParser = new TS.Parser();
    this.language = language;
    this.rawParser.setLanguage(language);
  }

  isCached(): boolean {
    return !!this.tree;
  }

  inValidate() {
    this.invalidate();
  }

  /** Re-parse the current buffer text (cached per tick only if unchanged). */
  parse() {
    const lines = this.backend.getBuffer();
    const text = lines.join('\n');
    if (this.tree && text === this.sourceText) return this.tree;
    this.sourceText = text;
    this.tree = this.rawParser.parse(this.sourceText);
    this.nodeCache = new Map();
    return this.tree;
  }

  root() {
    this.parse();
    return this.tree ? this.wrapNode(this.tree.rootNode) : null;
  }
}

/** Parser for a standalone string (vim.treesitter.get_string_parser). */
export class StringTreeParser extends BaseTreeParser {
  private src: string;

  constructor(src: string, lang: string, language: any) {
    super(lang);
    this.src = src;
    const TS = requireParserModule();
    this.rawParser = new TS.Parser();
    this.rawParser.setLanguage(language);
    this.parse();
  }

  parse() {
    if (this.tree && this.rawParser) return this.tree;
    this.tree = this.rawParser.parse(this.src);
    this.sourceText = this.src;
    return this.tree;
  }

  root() {
    this.parse();
    return this.tree ? this.wrapNode(this.tree.rootNode) : null;
  }
}

function requireParserModule(): any {
  const cached = (globalThis as any).__netvim_treesitter_module;
  if (cached) return cached;
  throw new Error('tree-sitter module not initialised');
}

export function setParserModule(TS: any) {
  (globalThis as any).__netvim_treesitter_module = TS;
}

const nodeRawById = new Map<number, any>();

export function registerRawNode(id: number, raw: any) {
  nodeRawById.set(id, raw);
}

/**
 * Resolve the raw web-tree-sitter node from a Lua-facing node object.
 * Tries the hidden `__raw` property first, then the id-based registry.
 */
export function unwrapNode(node: any): any {
  if (!node) return null;
  if (typeof node === 'object' && node.__raw) return node.__raw;
  if (typeof node.id === 'function') {
    const id = node.id();
    if (nodeRawById.has(id)) return nodeRawById.get(id);
  }
  return node;
}

export function clearNodeRawCache() {
  nodeRawById.clear();
}

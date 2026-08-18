import { decorateProxy } from 'wasmoon';
import { initTreeSitter } from './runtime';
import {
  LanguageLoader,
  DEFAULT_CDN_BASE,
  DEFAULT_PRELOAD_LANGS,
  extToLang,
  normalizeLang,
  langToExtension,
} from './language';
import { BufferTreeParser, StringTreeParser, clearNodeRawCache, setParserModule } from './parser';
import { TreesitterQuery } from './query';
import { TreeSitterHighlighter } from './highlight';
import { getDefaultHighlights } from './queries';
import type { LuaBackend } from '../backend';

export interface TreesitterInstallContext {
  backend: LuaBackend;
  registerLineRenderer: (opts: any) => void;
  rerender?: () => void;
  readGrammarBytes?: (lang: string) => Promise<Uint8Array | null>;
  cdnBase?: string;
  preload?: string[] | false;
}

export interface TreesitterAPI {
  loader: LanguageLoader;
  highlighter: TreeSitterHighlighter;
  install: (vim: Record<string, any>) => void;
}

export function createTreesitter(ctx: TreesitterInstallContext): TreesitterAPI {
  const backend = ctx.backend;
  const loader = new LanguageLoader({
    readGrammarBytes: ctx.readGrammarBytes,
    cdnBase: ctx.cdnBase ?? DEFAULT_CDN_BASE,
  });
  const highlighter = new TreeSitterHighlighter(
    { backend, registerLineRenderer: ctx.registerLineRenderer, rerender: ctx.rerender },
    loader
  );
  const bufferParsers = new Map<string, BufferTreeParser>();
  const queryCache = new Map<string, TreesitterQuery>();
  const userQueries = new Map<string, string>();
  // Languages whose highlighting is owned by a dedicated (non-treesitter)
  // plugin — e.g. the TypeScript LSP plugin. vim.treesitter.start() refuses
  // these so we don't run two highlighters over the same source.
  const disabledHighlightLangs: Set<string> = new Set();

  const kickstart = (langs: string[]) => {
    // Skip eager CDN preload under test runners to keep suites hermetic/fast.
    const isTest = typeof process !== 'undefined' && !!((process as any).env?.VITEST);
    if (isTest) return;
    initTreeSitter().then(async (TS) => {
      setParserModule(TS);
      await Promise.all(langs.map((lang) => loader.get(lang).catch(() => {})));
      // eslint-disable-next-line no-console
      console.log(`[vim.treesitter] preloaded grammars: ${langs.join(', ')}`);
    }).catch((err) => console.error('[vim.treesitter] init failed:', err));
  };

  const preload = ctx.preload ?? DEFAULT_PRELOAD_LANGS;
  if (preload) kickstart(Array.isArray(preload) ? preload : DEFAULT_PRELOAD_LANGS);

  /** Parse an already-loadable language; kicks async load when missing. */
  function resolveLanguage(lang: string): any | null {
    const key = normalizeLang(lang);
    if (!key) return null;
    if (!loader.isReady(key)) {
      loader.get(key).catch(() => {});
      return null;
    }
    return loader.getSync(key);
  }

  function parserFor(lang: string, language: any): BufferTreeParser {
    let parser = bufferParsers.get(lang);
    if (!parser) {
      parser = new BufferTreeParser(backend, lang, language);
      bufferParsers.set(lang, parser);
    }
    return parser;
  }

  function ensureTSModule(): any {
    return (globalThis as any).__netvim_treesitter_module;
  }

  function buildQuery(lang: string, source: string, parserThunk: () => BufferTreeParser | null): TreesitterQuery | null {
    const TS = ensureTSModule();
    const language = loader.getSync(lang);
    if (!TS || !language) return null;
    try {
      const query = new TS.Query(language, source);
      return new TreesitterQuery(lang, query, parserThunk);
    } catch (err) {
      console.error(`[vim.treesitter] bad query for ${lang}:`, err);
      return null;
    }
  }

  const getOverallParser = (lang: string): BufferTreeParser | null => {
    const language = resolveLanguage(lang);
    if (!language) return null;
    return parserFor(lang, language);
  };

  function queryFor(lang: string, name: string): TreesitterQuery | null {
    const key = `${lang}:${name}`;
    if (queryCache.has(key)) return queryCache.get(key)!;
    const source = userQueries.get(key) ?? getDefaultHighlights(lang);
    if (source == null) return null;
    const q = buildQuery(lang, source, () => getOverallParser(lang));
    if (q) queryCache.set(key, q);
    return q;
  }

  const install = (vim: Record<string, any>) => {
    const ts: Record<string, any> = {};

    ts.language = {
      get_lang: (bufnameOrBuf: any) => {
        if (typeof bufnameOrBuf === 'number') {
          return extToLang(backend.getCurrentFilePath() ?? '');
        }
        return extToLang(String(bufnameOrBuf ?? ''));
      },
      get_extension: (lang: string) => langToExtension(lang) ?? null,
      add: (lang: string, opts: any) => {
        if (opts && (opts.path || opts.filetype)) {
          // Recorded for later use; grammar must be retrievable via loader.
        }
      },
    };

    ts.get_parser = (bufnr: number, lang?: string) => {
      const resolvedLang = (lang ? normalizeLang(lang) : null) ?? ts.language.get_lang(bufnr);
      if (!resolvedLang) return null;
      const language = resolveLanguage(resolvedLang);
      if (!language) return null;
      const parser = parserFor(resolvedLang, language);
      const wrapped = decorateProxy({
        parse: () => { parser.parse(); return parser.makeTree(); },
        lang: () => resolvedLang,
        root: () => parser.root(),
        is_cached: () => parser.isCached(),
        in_process: () => false,
        included: () => false,
      }, { proxy: true });
      return wrapped;
    };

    ts.string_parser = (src: string, lang: string) => {
      const key = normalizeLang(lang);
      if (!key) return null;
      const language = resolveLanguage(key);
      if (!language) return null;
      const parser = new StringTreeParser(src, key, language);
      return decorateProxy({
        root: () => parser.root(),
        lang: () => key,
      }, { proxy: true });
    };
    ts.get_string_parser = ts.string_parser;

    ts.get_node = (args?: any) => {
      const buf = args && args.buf ? args.buf : 0;
      const pos = args && args.pos;
      const lang = (args && args.lang) || ts.language.get_lang(buf);
      if (!lang) return null;
      const parser = getOverallParser(lang);
      if (!parser) return null;
      const root = parser.root();
      if (!root) return null;
      const cursor = backend.getCursor();
      const row = pos && pos.row != null ? pos.row : cursor.y;
      const col = pos && pos.col != null ? pos.col : cursor.x;
      return root.named_descendant_for_pos(row, col);
    };

    ts.get_captures_at_pos = (bufnr: number, row: number, col: number) => {
      return highlighter.capturesAt(bufnr, row, col);
    };

    ts.start = (bufnr: number, lang?: string) => {
      const resolved = (lang ? normalizeLang(lang) : null) ?? ts.language.get_lang(bufnr);
      if (resolved && disabledHighlightLangs.has(resolved)) return false;
      return highlighter.start(bufnr, lang);
    };
    ts.stop = (bufnr: number) => highlighter.stop(bufnr);

    ts.query = {
      get_query: (lang: string, name: string) => {
        const key = normalizeLang(lang);
        if (!key || name !== 'highlights') return null;
        return queryFor(key, 'highlights');
      },
      compile: (lang: string, src: string) => {
        const key = normalizeLang(lang);
        if (!key) return null;
        return buildQuery(key, src, () => getOverallParser(key));
      },
      parse: (lang: string, src: string) => {
        const key = normalizeLang(lang);
        if (!key) return null;
        return buildQuery(key, src, () => getOverallParser(key));
      },
      set: (lang: string, name: string, src: string) => {
        const key = normalizeLang(lang);
        if (!key || !name) return false;
        const cacheKey = `${key}:${name}`;
        userQueries.set(cacheKey, src);
        queryCache.delete(cacheKey);
        return true;
      },
    };

    ts.foldexpr = function () { return null; };
    ts.inspect_tree = function () { console.warn('[vim.treesitter] inspect_tree UI is not supported'); };

    ts.highlighter = {
      active: decorateProxy(new Proxy({}, {
        get: (_t, prop) => {
          if (typeof prop === 'symbol') return undefined;
          return highlighter.getActive(Number(prop) || 0);
        },
        set: (_t, prop, value) => {
          const buf = Number(prop) || 0;
          if (value == null || value === false) highlighter.stop(buf);
          else highlighter.start(buf);
          return true;
        },
      }), { proxy: true }),
      // Let dedicated highlighters (e.g. the TypeScript LSP plugin) own a
      // language: vim.treesitter.start() then refuses to touch it.
      disable_lang: (lang: string) => {
        const key = normalizeLang(lang);
        if (key) disabledHighlightLangs.add(key);
      },
      enable_lang: (lang: string) => {
        const key = normalizeLang(lang);
        if (key) disabledHighlightLangs.delete(key);
      },
    };

    vim.treesitter = ts;
    vim.tree = ts;
  };

  return { loader, highlighter, install };
}

export function resetTreesitter() {
  clearNodeRawCache();
}

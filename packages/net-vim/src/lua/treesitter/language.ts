import { getTreeSitterModule } from './runtime';
import { setParserModule } from './parser';

export const DEFAULT_CDN_BASE =
  'https://unpkg.com/@vscode/tree-sitter-wasm@0.3.1/wasm';

// Filetype / extension -> canonical tree-sitter language name.
const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  css: 'css',
  java: 'java',
  php: 'php',
  rb: 'ruby',
  ini: 'ini',
  cfg: 'ini',
  ps1: 'powershell',
  psm1: 'powershell',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  cs: 'c_sharp',
  regex: 'regex',
};

// Common aliases (vim filetypes -> canonical language).
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  javascriptreact: 'javascript',
  typescript: 'typescript',
  tsx: 'tsx',
  python: 'python',
  rust: 'rust',
  go: 'go',
  c: 'cpp',
  cpp: 'cpp',
  css: 'css',
  java: 'java',
  php: 'php',
  ruby: 'ruby',
  ini: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  c_sharp: 'c_sharp',
  csharp: 'c_sharp',
  'c-sharp': 'c_sharp',
  regex: 'regex',
};

// Canonical language -> wasm file stem in @vscode/tree-sitter-wasm.
const GRAMMAR_FILE: Record<string, string> = {
  bash: 'tree-sitter-bash',
  c_sharp: 'tree-sitter-c-sharp',
  cpp: 'tree-sitter-cpp',
  css: 'tree-sitter-css',
  go: 'tree-sitter-go',
  ini: 'tree-sitter-ini',
  java: 'tree-sitter-java',
  javascript: 'tree-sitter-javascript',
  php: 'tree-sitter-php',
  powershell: 'tree-sitter-powershell',
  python: 'tree-sitter-python',
  regex: 'tree-sitter-regex',
  ruby: 'tree-sitter-ruby',
  rust: 'tree-sitter-rust',
  tsx: 'tree-sitter-tsx',
  typescript: 'tree-sitter-typescript',
};

export interface LanguageLoaderOptions {
  readGrammarBytes?: (lang: string) => Promise<Uint8Array | null>;
  cdnBase?: string;
}

export class LanguageLoader {
  private cache: Map<string, Promise<any>> = new Map();
  private ready: Set<string> = new Set();
  private module: any = null;
  private readonly opts: LanguageLoaderOptions;

  constructor(opts: LanguageLoaderOptions = {}) {
    this.opts = opts;
  }

  get cdnBase() {
    return this.opts.cdnBase ?? DEFAULT_CDN_BASE;
  }

  isReady(lang: string): boolean {
    return this.ready.has(normalizeLang(lang) ?? lang);
  }

  /** Returns a synchronously-usable Language for `lang`, or null if not loaded. */
  getSync(lang: string): any | null {
    const key = normalizeLang(lang) ?? lang;
    const cached = this.cache.get(key);
    if (!cached) return null;
    const language = this.peek(cached);
    return language ?? null;
  }

  private peek(promise: Promise<any>): any | null {
    // A promise that has already settled holds the value synchronously.
    const race = (promise as any).__value;
    return race !== undefined ? race : null;
  }

  async get(lang: string): Promise<any> {
    const key = normalizeLang(lang) ?? lang;
    if (!this.cache.has(key)) {
      const prom = this.load(key);
      prom.then((language) => {
        (prom as any).__value = language;
        this.ready.add(key);
      }).catch(() => {});
      this.cache.set(key, prom);
    }
    return this.cache.get(key)!;
  }

  private async load(key: string): Promise<any> {
    const bytes = await this.loadBytes(key);
    if (!bytes) throw new Error(`No tree-sitter grammar available for '${key}'`);
    this.module = this.module ?? (await getTreeSitterModule());
    setParserModule(this.module);
    const language = await this.module.Language.load(bytes);
    return language;
  }

  /**
   * Resolve grammar bytes: user-supplied override first, then CDN.
   * Also accepts a raw path/URL string for dict/ini-style keys that don't exist
   * in the @vscode set (returns null -> caller warns).
   */
  private async loadBytes(lang: string): Promise<Uint8Array | null> {
    if (this.opts.readGrammarBytes) {
      const fromUser = await this.opts.readGrammarBytes(lang);
      if (fromUser) return fromUser;
    }
    const file = GRAMMAR_FILE[lang];
    if (!file) return null;
    const url = `${this.cdnBase}/${file}.wasm`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch grammar ${url} (${res.status})`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
}

/** Languages preloaded eagerly so `get_parser()` works synchronously. */
export const DEFAULT_PRELOAD_LANGS = [
  'javascript',
  'typescript',
  'tsx',
  'python',
  'rust',
  'go',
  'bash',
  'cpp',
];

export function normalizeLang(lang: string): string | null {
  const l = String(lang ?? '').toLowerCase();
  if (!l) return null;
  return LANG_ALIASES[l] ?? l;
}

export function extToLang(path: string): string | null {
  const p = String(path ?? '');
  const base = p.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export function langToExtension(lang: string): string | undefined {
  for (const [ext, l] of Object.entries(EXT_TO_LANG)) {
    if (l === lang) return ext;
  }
  return undefined;
}

export function hasGrammar(lang: string): boolean {
  const key = normalizeLang(lang) ?? lang;
  return !!GRAMMAR_FILE[key];
}

export function availableLanguages(): string[] {
  return Object.keys(GRAMMAR_FILE);
}

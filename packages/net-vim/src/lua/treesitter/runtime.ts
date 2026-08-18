import tsWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';

let initPromise: Promise<any> | null = null;

function resolveWasmPath(url: string): string {
  // Vite SSR (vitest node env) rewrites `?url` to `/@fs/<abs-path>` which the
  // Emscripten node loader can't open directly; translate back to a real path.
  if (url.startsWith('/@fs/')) return url.replace(/^\/@fs\//, '/');
  return url;
}

/**
 * Initialises the web-tree-sitter runtime exactly once. Must run before any
 * Parser/Language is created. Passes the bundled wasm through `locateFile` so
 * bundlers (Vite) can inline/emit it reliably.
 */
export function initTreeSitter(): Promise<any> {
  if (!initPromise) {
    initPromise = (async () => {
      const TS = await import('web-tree-sitter');
      await TS.Parser.init({
        locateFile: (path: string) => {
          if (path.endsWith('.wasm')) return resolveWasmPath(tsWasmUrl);
          return path;
        },
      });
      return TS;
    })();
  }
  return initPromise;
}

export async function getTreeSitterModule(): Promise<any> {
  return initTreeSitter();
}

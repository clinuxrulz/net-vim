import type { FileSystem } from '../types';
import type { LuaModuleLoader } from './shim';

export const LUA_BASE = '.config/net-vim/lua';

export async function buildModuleLoader(fs: FileSystem, basePath: string = LUA_BASE): Promise<LuaModuleLoader> {
  const cache = new Map<string, string | null>();

  async function scan(): Promise<void> {
    try {
      const entries = await fs.listDirectory(basePath);
      await Promise.all(entries.map(async (entry) => {
        const full = `${basePath}/${entry}`;
        try {
          const isDir = await fs.isDirectory(full);
          if (isDir) {
            const children = await fs.listDirectory(full);
            await Promise.all(children.map(async (child) => {
              if (child.endsWith('.lua')) {
                const rel = `${entry}/${child}`;
                cache.set(rel.replace(/\/init\.lua$/, '').replace(/\.lua$/, ''), await fs.readFile(`${full}/${child}`));
              }
            }));
          } else if (entry.endsWith('.lua')) {
            cache.set(entry.replace(/\.lua$/, ''), await fs.readFile(full));
          }
        } catch {
          // Ignore individual entries that can't be listed/read.
        }
      }));
    } catch {
      // No lua directory; treat as empty.
    }
  }

  await scan();

  return (name: string): string | null => {
    const clean = name.replace(/\.lua$/, '');
    if (cache.has(clean)) return cache.get(clean) ?? null;
    const fromInit = cache.get(`${clean}/init`);
    if (fromInit !== undefined) return fromInit;
    return null;
  };
}

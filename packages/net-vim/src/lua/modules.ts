import type { FileSystem } from '../types';
import type { LuaModuleLoader } from './shim';
import { LUA_PLUGIN_FILES } from '../lua-plugins';

export const LUA_BASE = '.config/net-vim/lua';

export async function buildModuleLoader(fs: FileSystem, basePath: string = LUA_BASE): Promise<LuaModuleLoader> {
  const cache = new Map<string, string | null>();

  // Seed with bundled plugins (which-key etc.); user files below override them.
  for (const [rel, content] of Object.entries(LUA_PLUGIN_FILES)) {
    cache.set(rel.replace(/\/init\.lua$/, '').replace(/\.lua$/, ''), content);
  }
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
    const slashKey = clean.replace(/\./g, '/');
    if (cache.has(slashKey)) return cache.get(slashKey) ?? null;
    const fromInit = cache.get(`${clean}/init`) ?? cache.get(`${slashKey}/init`);
    if (fromInit !== undefined) return fromInit;
    return null;
  };
}

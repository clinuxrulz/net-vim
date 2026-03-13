import { PRELUDE_PLUGINS } from './prelude';
import type { FileSystem } from './types';

/**
 * Simple utility to interact with the Origin Private File System (OPFS)
 * or fallback to a memory-based file system.
 */

export const PRELUDE_BASE = '.config/net-vim/prelude';

// Memory FS Fallback
const memoryStore = new Map<string, string>();

// Pre-populate memory store with virtual prelude files
for (const [name, content] of Object.entries(PRELUDE_PLUGINS)) {
  memoryStore.set(`${PRELUDE_BASE}/${name}`, content);
}

const memoryFS = {
  readFile: async (path: string) => memoryStore.get(path) || null,
  writeFile: async (path: string, content: string) => {
    if (path.startsWith(PRELUDE_BASE)) throw new Error('Cannot write to read-only virtual prelude path');
    memoryStore.set(path, content);
  },
  listDirectory: async (path: string) => {
    const cleanPath = path.endsWith('/') ? path.slice(0, -1) : path;
    const entries = new Set<string>();
    for (const key of memoryStore.keys()) {
      if (key.startsWith(cleanPath + '/') || (cleanPath === '' && !key.includes('/'))) {
        const relative = cleanPath === '' ? key : key.slice(cleanPath.length + 1);
        const parts = relative.split('/');
        if (parts.length > 1) entries.add(parts[0] + '/');
        else entries.add(parts[0]);
      }
    }
    return Array.from(entries).sort();
  },
  isDirectory: async (path: string) => {
    if (path === '' || path === '.' || path === './') return true;
    const cleanPath = path.endsWith('/') ? path.slice(0, -1) : path;
    for (const key of memoryStore.keys()) {
      if (key.startsWith(cleanPath + '/')) return true;
    }
    return false;
  }
};

let fsImplementation: FileSystem | null = null;

async function getFS() {
  if (fsImplementation) return fsImplementation;

  try {
    // Check if OPFS is available and not restricted
    const root = await navigator.storage.getDirectory();
    // Test if we can actually do something (restricted iframes might fail later)
    await root.getDirectoryHandle('.test-access', { create: true });
    await root.removeEntry('.test-access');
    
    fsImplementation = opfsFS;
    console.log('[FS] Using OPFS');
  } catch (e) {
    console.warn('[FS] OPFS not available or restricted, falling back to MemoryFS', e);
    fsImplementation = memoryFS;
  }
  return fsImplementation;
}

export const opfsFS = {
  readFile: getConfigFile,
  writeFile: writeConfigFile,
  listDirectory,
  isDirectory,
};

// Exported wrapper that detects FS on first use
export const autoFS = {
  readFile: async (path: string) => (await getFS()).readFile(path),
  writeFile: async (path: string, content: string) => (await getFS()).writeFile(path, content),
  listDirectory: async (path: string) => (await getFS()).listDirectory(path),
  isDirectory: async (path: string) => (await getFS()).isDirectory(path),
};

export async function getConfigFile(path: string): Promise<string | null> {
  // Handle virtual prelude files
  if (path.startsWith(PRELUDE_BASE + '/')) {
    const fileName = path.slice(PRELUDE_BASE.length + 1);
    return PRELUDE_PLUGINS[fileName] || null;
  }

  try {
    const root = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(p => p.length > 0);
    
    let currentDir = root;
    // Navigate to the directory containing the file
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false });
    }
    
    const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (e) {
    // File or directory doesn't exist
    return null;
  }
}

export async function ensureConfigDir(path: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const parts = path.split('/').filter(p => p.length > 0);
  
  let currentDir = root;
  for (const part of parts) {
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }
  return currentDir;
}

export async function writeConfigFile(path: string, content: string): Promise<void> {
  // Prevent writing to virtual prelude files
  if (path.startsWith(PRELUDE_BASE)) {
    throw new Error('Cannot write to read-only virtual prelude path');
  }

  const root = await navigator.storage.getDirectory();
  const parts = path.split('/').filter(p => p.length > 0);
  
  let currentDir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true });
  }
  
  const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function listDirectory(path: string): Promise<string[]> {
  const entries: string[] = [];

  // Handle virtual prelude listing
  if (path === PRELUDE_BASE || path === PRELUDE_BASE + '/') {
    return Object.keys(PRELUDE_PLUGINS).sort();
  }

  try {
    const root = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(p => p.length > 0);
    
    let currentDir = root;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: false });
    }
    
    // @ts-ignore - Some browsers might need different iteration
    for await (const [name, handle] of currentDir.entries()) {
      entries.push(handle.kind === 'directory' ? `${name}/` : name);
    }

    // If we're listing .config/net-vim, manually add prelude/
    if (path === '.config/net-vim' || path === '.config/net-vim/') {
      if (!entries.includes('prelude/')) {
        entries.push('prelude/');
      }
    }

    return entries.sort();
  } catch (e) {
    // If it's a sub-part of the path to prelude, we might need to pretend it exists
    if (PRELUDE_BASE.startsWith(path) && path.length > 0) {
      const nextPart = PRELUDE_BASE.slice(path.length).split('/').filter(p => p.length > 0)[0];
      if (nextPart) return [`${nextPart}/`];
    }
    return [];
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  if (path === '.' || path === './' || path === '') return true;
  
  // Handle virtual prelude directory
  const cleanPath = path.endsWith('/') ? path.slice(0, -1) : path;
  if (cleanPath === PRELUDE_BASE) return true;

  try {
    const root = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(p => p.length > 0);
    
    let currentDir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false });
    }
    
    await currentDir.getDirectoryHandle(parts[parts.length - 1], { create: false });
    return true;
  } catch (e) {
    // If it's a sub-part of the path to prelude, we pretend it exists
    if (PRELUDE_BASE.startsWith(cleanPath) && cleanPath.length > 0) return true;
    return false;
  }
}


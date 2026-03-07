/**
 * Simple utility to interact with the Origin Private File System (OPFS)
 */

export async function getConfigFile(path: string): Promise<string | null> {
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
  try {
    const root = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(p => p.length > 0);
    
    let currentDir = root;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: false });
    }
    
    const entries: string[] = [];
    // @ts-ignore - Some browsers might need different iteration
    for await (const [name, handle] of currentDir.entries()) {
      entries.push(handle.kind === 'directory' ? `${name}/` : name);
    }
    return entries;
  } catch (e) {
    return [];
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  if (path === '.' || path === './' || path === '') return true;
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
    return false;
  }
}

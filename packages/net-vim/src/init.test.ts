import { describe, it, expect, vi } from 'vitest';
import { initNetVim } from './index';
import { autoFS } from './opfs-util';

vi.mock('solid-js/web', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    render: vi.fn(),
  };
});

vi.mock('./wasm/tui_engine', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  Engine: vi.fn().mockImplementation(() => ({
    render: vi.fn().mockReturnValue({ chars: [], fgs: [], bgs: [] }),
  })),
}));

vi.mock('./utils', () => ({
  loadScript: vi.fn().mockResolvedValue(undefined),
}));

// Mock navigator.storage.getDirectory for when no custom FS is provided
(globalThis as any).navigator = {
  storage: {
    getDirectory: vi.fn().mockRejectedValue(new Error('OPFS not available')),
  },
  clipboard: {
    writeText: vi.fn(),
    readText: vi.fn(),
  },
};

describe('initNetVim custom FS', () => {
  it('should use provided custom file system', async () => {
    const customFS = {
      readFile: vi.fn().mockResolvedValue('test content'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      listDirectory: vi.fn().mockResolvedValue([]),
      isDirectory: vi.fn().mockResolvedValue(false),
    };

    const container = document.createElement('div');
    await initNetVim(container, { fileSystem: customFS });

    const content = await autoFS.readFile('test.txt');
    expect(content).toBe('test content');
    expect(customFS.readFile).toHaveBeenCalledWith('test.txt');
  });

  it('should auto-create init.ts if autoCreateInit is true', async () => {
    const files = new Map<string, string>();
    const customFS = {
      readFile: vi.fn().mockImplementation(async (path) => {
        return files.get(path) || null;
      }),
      writeFile: vi.fn().mockImplementation(async (path, content) => {
        files.set(path, content);
      }),
      listDirectory: vi.fn().mockResolvedValue([]),
      isDirectory: vi.fn().mockResolvedValue(false),
    };

    const container = document.createElement('div');
    await initNetVim(container, { fileSystem: customFS, autoCreateInit: true });

    const initContent = files.get('.config/net-vim/init.ts');
    expect(initContent).toBeDefined();
    expect(initContent).toContain('Custom init.ts loaded!');
  });
});

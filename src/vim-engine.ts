import { PluginManager } from './plugin-manager';
import type { VimMode, VimEvent, VimAPI } from './types';
import { getConfigFile, writeConfigFile, listDirectory, isDirectory } from './opfs-util';

export class VimEngine {
  private buffer: string[] = ['Welcome to Web-Vim!', 'Press i to insert text', 'Press Esc to return to Normal mode', 'Type :q to quit'];
  private cursor = { x: 0, y: 0 };
  private mode: VimMode = 'Normal';
  private commandText = '';
  private currentFilePath: string | null = null;
  private isExplorer = false;
  private explorerPath = '';
  private commands: Record<string, (args: string[]) => void> = {};
  private onUpdate: () => void;
  private eventListeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  private pluginManager: PluginManager;

  constructor(onUpdate: () => void) {
    this.onUpdate = onUpdate;
    this.registerBuiltinCommands();
    this.pluginManager = new PluginManager(() => this.getAPI());
  }

  private registerBuiltinCommands() {
    this.commands['q'] = () => {
      console.log('Quitting...');
    };
    
    this.commands['w'] = async (args) => {
      if (this.isExplorer) {
        console.error('Cannot save a directory buffer');
        return;
      }
      const targetPath = args[0] || this.currentFilePath;
      if (!targetPath) {
        console.error('No file name');
        return;
      }
      
      try {
        await writeConfigFile(targetPath, this.buffer.join('\n'));
        this.currentFilePath = targetPath;
        console.log(`"${targetPath}" saved`);
        this.onUpdate();
      } catch (err) {
        console.error('Failed to save file:', err);
      }
    };

    this.commands['e'] = async (args) => {
      let path = args[0] || '.';
      if (path === '.') path = ''; // Root
      
      try {
        if (await isDirectory(path)) {
          await this.openDirectory(path);
        } else {
          await this.openFile(path);
        }
      } catch (err) {
        console.error('Failed to open:', err);
      }
    };
  }

  private async openDirectory(path: string) {
    const entries = await listDirectory(path);
    this.buffer = [
      `" Explorer: ${path || '/'}`,
      `" ============================================================================`,
      '../',
      ...entries.sort((a, b) => {
        // Directories first
        if (a.endsWith('/') && !b.endsWith('/')) return -1;
        if (!a.endsWith('/') && b.endsWith('/')) return 1;
        return a.localeCompare(b);
      })
    ];
    this.isExplorer = true;
    this.explorerPath = path;
    this.currentFilePath = null;
    this.cursor = { x: 0, y: 2 }; // Start at '../'
    this.onUpdate();
  }

  private async openFile(path: string) {
    const content = await getConfigFile(path);
    if (content !== null) {
      this.buffer = content.split('\n');
      this.currentFilePath = path;
      this.isExplorer = false;
      this.cursor = { x: 0, y: 0 };
      this.trigger('TextChanged');
      this.onUpdate();
      console.log(`Opened "${path}"`);
    } else {
      this.buffer = [''];
      this.currentFilePath = path;
      this.isExplorer = false;
      this.cursor = { x: 0, y: 0 };
      this.onUpdate();
      console.log(`[New File] "${path}"`);
    }
  }

  public getAPI(): VimAPI {
    return {
      registerCommand: (name, callback) => { this.commands[name] = callback; },
      getBuffer: () => [...this.buffer],
      setBuffer: (buffer: string[]) => { this.buffer = [...buffer]; this.trigger('TextChanged'); this.onUpdate(); },
      getCursor: () => ({ ...this.cursor }),
      setCursor: (x, y) => { this.setCursor(x, y); },
      getMode: () => this.mode,
      on: (event, callback) => {
        if (!this.eventListeners.has(event)) {
          this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(callback);
      },
      executeCommand: (cmd) => this.executeCommand(cmd),
      loadPluginFromSource: (name, source) => this.loadPluginFromSource(name, source),
    };
  }

  private trigger(event: VimEvent, ...args: any[]) {
    this.eventListeners.get(event)?.forEach(cb => cb(...args));
  }

  public async loadPluginFromSource(name: string, tsSource: string) {
    return this.pluginManager.loadPluginFromSource(name, tsSource);
  }

  public setCursor(x: number, y: number) {
    this.cursor.y = Math.max(0, Math.min(this.buffer.length - 1, y));
    const lineLen = this.buffer[this.cursor.y]?.length || 0;
    this.cursor.x = Math.max(0, Math.min(lineLen, x));
    this.trigger('CursorMoved', this.cursor);
    this.onUpdate();
  }

  public getState() {
    return {
      buffer: this.buffer,
      cursor: this.cursor,
      mode: this.mode,
      commandText: this.commandText,
      currentFilePath: this.currentFilePath,
      isExplorer: this.isExplorer,
      explorerPath: this.explorerPath,
      plugins: this.pluginManager.getLoadedPlugins(),
    };
  }

  public handleKey(key: string, _ctrl: boolean = false) {
    if (this.isExplorer && this.mode === 'Normal' && key === 'Enter') {
      this.handleExplorerSelect();
      this.onUpdate();
      return;
    }

    const oldMode = this.mode;
    if (this.mode === 'Normal') {
      this.handleNormalMode(key, _ctrl);
    } else if (this.mode === 'Insert') {
      this.handleInsertMode(key, _ctrl);
    } else if (this.mode === 'Command') {
      this.handleCommandMode(key, _ctrl);
    }
    
    if (this.mode !== oldMode) {
      this.trigger('ModeChanged', { from: oldMode, to: this.mode });
    }
    
    this.onUpdate();
  }

  private async handleExplorerSelect() {
    const line = this.buffer[this.cursor.y];
    if (!line || line.startsWith('"')) return;

    let target = line.trim();
    let fullPath = '';

    if (target === '../') {
      // Go up
      const parts = this.explorerPath.split('/').filter(p => p.length > 0);
      parts.pop();
      fullPath = parts.join('/');
    } else {
      fullPath = this.explorerPath ? `${this.explorerPath}/${target}` : target;
    }

    // Remove trailing slash for isDirectory check if needed, 
    // but our listDirectory adds it for visual distinction.
    const cleanPath = fullPath.endsWith('/') ? fullPath.slice(0, -1) : fullPath;

    if (await isDirectory(cleanPath)) {
      await this.openDirectory(cleanPath);
    } else {
      await this.openFile(cleanPath);
    }
  }

  private moveCursor(direction: 'left' | 'down' | 'up' | 'right') {
    switch (direction) {
      case 'left': this.cursor.x = Math.max(0, this.cursor.x - 1); break;
      case 'down': this.cursor.y = Math.min(this.buffer.length - 1, this.cursor.y + 1); break;
      case 'up': this.cursor.y = Math.max(0, this.cursor.y - 1); break;
      case 'right':
        const lineLen = this.buffer[this.cursor.y]?.length || 0;
        this.cursor.x = Math.min(lineLen, this.cursor.x + 1);
        break;
    }
    // Constrain cursor X after movement (especially vertical)
    const currentLineLen = this.buffer[this.cursor.y]?.length || 0;
    if (this.cursor.x > currentLineLen) {
      this.cursor.x = Math.max(0, currentLineLen);
    }
  }

  private handleNormalMode(key: string, _ctrl: boolean) {
    switch (key) {
      case 'i': this.mode = 'Insert'; break;
      case ':': this.mode = 'Command'; this.commandText = ''; break;
      case "ArrowLeft":
      case 'h': this.moveCursor('left'); break;
      case "ArrowDown":
      case 'j': this.moveCursor('down'); break;
      case "ArrowUp":
      case 'k': this.moveCursor('up'); break;
      case "ArrowRight":
      case 'l': this.moveCursor('right'); break;
      case 'Home': this.cursor.x = 0; break;
      case 'End': this.cursor.x = this.buffer[this.cursor.y]?.length || 0; break;
      case 'PageUp': this.cursor.y = Math.max(0, this.cursor.y - 10); break;
      case 'PageDown': this.cursor.y = Math.min(this.buffer.length - 1, this.cursor.y + 10); break;
      case 'x': // delete character under cursor
        const line = this.buffer[this.cursor.y];
        if (line && line.length > 0) {
          this.buffer[this.cursor.y] = line.slice(0, this.cursor.x) + line.slice(this.cursor.x + 1);
        }
        break;
    }
  }

  private handleInsertMode(key: string, _ctrl: boolean) {
    if (key === 'Escape') {
      this.mode = 'Normal';
      return;
    }

    if (key === 'ArrowLeft') { this.moveCursor('left'); return; }
    if (key === 'ArrowDown') { this.moveCursor('down'); return; }
    if (key === 'ArrowUp') { this.moveCursor('up'); return; }
    if (key === 'ArrowRight') { this.moveCursor('right'); return; }
    if (key === 'Home') { this.cursor.x = 0; return; }
    if (key === 'End') { this.cursor.x = this.buffer[this.cursor.y]?.length || 0; return; }
    if (key === 'PageUp') { this.cursor.y = Math.max(0, this.cursor.y - 10); return; }
    if (key === 'PageDown') { this.cursor.y = Math.min(this.buffer.length - 1, this.cursor.y + 10); return; }

    if (key === 'Backspace') {
      if (this.cursor.x > 0) {
        const line = this.buffer[this.cursor.y];
        this.buffer[this.cursor.y] = line.slice(0, this.cursor.x - 1) + line.slice(this.cursor.x);
        this.cursor.x--;
      } else if (this.cursor.y > 0) {
        // Merge with previous line
        const prevLine = this.buffer[this.cursor.y - 1];
        const currentLine = this.buffer[this.cursor.y];
        this.cursor.x = prevLine.length;
        this.buffer[this.cursor.y - 1] = prevLine + currentLine;
        this.buffer.splice(this.cursor.y, 1);
        this.cursor.y--;
      }
    } else if (key === 'Enter') {
      const line = this.buffer[this.cursor.y];
      const left = line.slice(0, this.cursor.x);
      const right = line.slice(this.cursor.x);
      this.buffer[this.cursor.y] = left;
      this.buffer.splice(this.cursor.y + 1, 0, right);
      this.cursor.y++;
      this.cursor.x = 0;
    } else if (key.length === 1) {
      const line = this.buffer[this.cursor.y] || '';
      this.buffer[this.cursor.y] = line.slice(0, this.cursor.x) + key + line.slice(this.cursor.x);
      this.cursor.x++;
    }
  }

  private handleCommandMode(key: string, _ctrl: boolean) {
    if (key === 'Escape') {
      this.mode = 'Normal';
      this.commandText = '';
    } else if (key === 'Enter') {
      this.executeCommand(this.commandText);
      this.mode = 'Normal';
      this.commandText = '';
    } else if (key === 'Backspace') {
      if (this.commandText.length > 0) {
        this.commandText = this.commandText.slice(0, -1);
      } else {
        this.mode = 'Normal';
      }
    } else if (key.length === 1) {
      this.commandText += key;
    }
  }

  private executeCommand(cmd: string) {
    const [name, ...args] = cmd.trim().split(/\s+/);
    if (this.commands[name]) {
      this.commands[name](args);
    } else {
      console.warn(`Command not found: ${name}`);
    }
  }
}

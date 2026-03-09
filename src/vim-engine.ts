import { PluginManager } from './plugin-manager';
import type { VimMode, VimEvent, VimAPI, GutterOptions, CompletionItem, FileSystem, ContextMenuItem, VimState, LineRendererOptions } from './types';
import { opfsFS, PRELUDE_BASE } from './opfs-util';

export class VimEngine {
  private buffer: string[] = ['Welcome to Web-Vim!', 'Press i to insert text', 'Press Esc to return to Normal mode', 'Type :q to quit'];
  private cursor = { x: 0, y: 0 };
  private topLine = 0;
  private leftCol = 0;
  private viewportHeight = 22;
  private viewportWidth = 80; // Default, will be updated by UI
  private mode: VimMode = 'Normal';
  private commandText = '';
  private currentFilePath: string | null = null;
  private isExplorer = false;
  private explorerPath = '';
  private isReadOnly = false;
  private gutters: GutterOptions[] = [];
  private lineRenderers: LineRendererOptions[] = [];
  private contextMenuItems: ContextMenuItem[] = [];
  private commands: Record<string, (args: string[]) => void> = {};
  private onUpdate: () => void;
  private eventListeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  private pluginManager: PluginManager;
  private fs: FileSystem = opfsFS;

  // Completion & Hover State
  private completionItems: CompletionItem[] = [];
  private selectedCompletionIndex = 0;
  private onCompletionSelect: ((item: CompletionItem) => void) | null = null;
  private hoverText: string | null = null;
  private hoverPos = { x: 0, y: 0 };

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
      if (this.isReadOnly) {
        console.error('Cannot save a read-only buffer');
        return;
      }
      const targetPath = args[0] || this.currentFilePath;
      if (!targetPath) {
        console.error('No file name');
        return;
      }
      
      try {
        const content = this.buffer.join('\n');
        await this.fs.writeFile(targetPath, content);
        this.currentFilePath = targetPath;
        console.log(`"${targetPath}" saved`);
        this.trigger('FileChanged', { path: targetPath, content });
        this.onUpdate();
      } catch (err) {
        console.error('Failed to save file:', err);
      }
    };

    this.commands['e'] = async (args) => {
      let path = args[0] || '.';
      if (path === '.') path = ''; // Root
      
      try {
        if (await this.fs.isDirectory(path)) {
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
    const entries = await this.fs.listDirectory(path);
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
    const content = await this.fs.readFile(path);
    if (content !== null) {
      this.buffer = content.split('\n');
      this.currentFilePath = path;
      this.isExplorer = false;
      this.isReadOnly = path.startsWith(PRELUDE_BASE);
      this.cursor = { x: 0, y: 0 };
      this.trigger('TextChanged');
      this.trigger('BufferLoaded', { path, content });
      this.onUpdate();
      console.log(`Opened "${path}"${this.isReadOnly ? ' [ReadOnly]' : ''}`);
    } else {
      this.buffer = [''];
      this.currentFilePath = path;
      this.isExplorer = false;
      this.isReadOnly = false;
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
      registerGutter: (options: GutterOptions) => {
        console.log(`[VimEngine] Registering gutter: ${options.name}`, options);
        this.gutters.push(options);
        this.gutters.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        this.onUpdate();
      },
      registerLineRenderer: (options: LineRendererOptions) => {
        console.log(`[VimEngine] Registering line renderer: ${options.name}`);
        this.lineRenderers.push(options);
        this.lineRenderers.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        this.onUpdate();
      },
      
      showCompletions: (items, onSelect) => {
        this.completionItems = items;
        this.selectedCompletionIndex = 0;
        this.onCompletionSelect = onSelect;
        this.onUpdate();
      },
      hideCompletions: () => {
        this.completionItems = [];
        this.onCompletionSelect = null;
        this.onUpdate();
      },
      showHover: (text, x, y) => {
        this.hoverText = text;
        this.hoverPos = { x, y };
        this.onUpdate();
      },
      hideHover: () => {
        this.hoverText = null;
        this.onUpdate();
      },
      registerContextMenuItem: (item) => {
        this.contextMenuItems.push(item);
        this.contextMenuItems.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        this.onUpdate();
      },
      insertText: (text) => {
        if (this.isReadOnly && this.mode !== 'Command') return;
        
        if (this.mode === 'Command') {
          this.commandText += text.replace(/\r?\n/g, ''); // Don't allow newlines in command line
          this.onUpdate();
          return;
        }

        const lines = text.split(/\r?\n/);
        const currentLine = this.buffer[this.cursor.y] || '';
        const before = currentLine.slice(0, this.cursor.x);
        const after = currentLine.slice(this.cursor.x);

        if (lines.length === 1) {
          this.buffer[this.cursor.y] = before + lines[0] + after;
          this.setCursor(this.cursor.x + lines[0].length, this.cursor.y);
        } else {
          this.buffer[this.cursor.y] = before + lines[0];
          const middle = lines.slice(1, -1);
          const last = lines[lines.length - 1] + after;
          
          const newLines = [this.buffer[this.cursor.y], ...middle, last];
          this.buffer.splice(this.cursor.y, 1, ...newLines);
          this.setCursor(lines[lines.length - 1].length, this.cursor.y + lines.length - 1);
        }
        this.trigger('TextChanged');
        this.onUpdate();
      },
      setFS: (fs) => { this.fs = fs; },
      getFS: () => this.fs,
      resetFS: () => { this.fs = opfsFS; },
    };
  }

  public hideCompletions() {
    this.completionItems = [];
    this.onCompletionSelect = null;
    this.onUpdate();
  }

  public setViewportHeight(height: number) {
    this.viewportHeight = height;
    this.scrollCursorIntoView();
    this.onUpdate();
  }

  public setViewportWidth(width: number) {
    this.viewportWidth = width;
    this.scrollCursorIntoView();
    this.onUpdate();
  }

  private scrollCursorIntoView() {
    // Vertical
    if (this.cursor.y < this.topLine) {
      this.topLine = this.cursor.y;
    } else if (this.cursor.y >= this.topLine + this.viewportHeight) {
      this.topLine = this.cursor.y - this.viewportHeight + 1;
    }

    // Horizontal
    if (this.cursor.x < this.leftCol) {
      this.leftCol = this.cursor.x;
    } else if (this.cursor.x >= this.leftCol + this.viewportWidth) {
      this.leftCol = this.cursor.x - this.viewportWidth + 1;
    }
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
    this.scrollCursorIntoView();
    this.trigger('CursorMoved', this.cursor);
    this.onUpdate();
  }

  public getState(): VimState {
    return {
      buffer: this.buffer,
      cursor: this.cursor,
      topLine: this.topLine,
      leftCol: this.leftCol,
      viewportHeight: this.viewportHeight,
      viewportWidth: this.viewportWidth,
      mode: this.mode,
      commandText: this.commandText,
      currentFilePath: this.currentFilePath,
      isExplorer: this.isExplorer,
      explorerPath: this.explorerPath,
      isReadOnly: this.isReadOnly,
      plugins: this.pluginManager.getLoadedPlugins(),
      gutters: this.gutters,
      lineRenderers: this.lineRenderers,
      contextMenuItems: this.contextMenuItems,
      completionItems: this.completionItems,
      selectedCompletionIndex: this.selectedCompletionIndex,
      hoverText: this.hoverText,
      hoverPos: this.hoverPos,
    };
  }

  public handleKey(key: string, _ctrl: boolean = false) {
    this.trigger('KeyDown', { key, ctrl: _ctrl });

    // Intercept keys if completions are showing
    if (this.completionItems.length > 0) {
      if (key === 'ArrowDown' || (key === 'n' && _ctrl)) {
        this.selectedCompletionIndex = (this.selectedCompletionIndex + 1) % this.completionItems.length;
        this.onUpdate();
        return;
      }
      if (key === 'ArrowUp' || (key === 'p' && _ctrl)) {
        this.selectedCompletionIndex = (this.selectedCompletionIndex - 1 + this.completionItems.length) % this.completionItems.length;
        this.onUpdate();
        return;
      }
      if (key === 'Enter' || key === 'Tab') {
        const item = this.completionItems[this.selectedCompletionIndex];
        if (this.onCompletionSelect) {
          this.onCompletionSelect(item);
        }
        this.hideCompletions();
        return;
      }
      if (key === 'Escape') {
        this.hideCompletions();
        return;
      }
      if (key === 'Backspace') {
        this.hideCompletions();
      }
    }

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
    
    // Check if buffer might have changed
    if (this.mode === 'Insert' || (this.mode === 'Normal' && key === 'x')) {
      this.trigger('TextChanged');
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

    if (await this.fs.isDirectory(cleanPath)) {
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
    this.scrollCursorIntoView();
  }

  private handleNormalMode(key: string, ctrl: boolean) {
    if (ctrl) {
      switch (key) {
        case 'd': // Scroll down half page
          const halfPage = Math.floor(this.viewportHeight / 2);
          this.setCursor(this.cursor.x, this.cursor.y + halfPage);
          break;
        case 'u': // Scroll up half page
          const upHalfPage = Math.floor(this.viewportHeight / 2);
          this.setCursor(this.cursor.x, this.cursor.y - upHalfPage);
          break;
        case 'e': // Scroll down 1 line (cursor stays on line if possible)
          if (this.topLine < this.buffer.length - 1) {
            this.topLine++;
            if (this.cursor.y < this.topLine) {
              this.setCursor(this.cursor.x, this.topLine);
            }
          }
          break;
        case 'y': // Scroll up 1 line
          if (this.topLine > 0) {
            this.topLine--;
            if (this.cursor.y >= this.topLine + this.viewportHeight) {
              this.setCursor(this.cursor.x, this.topLine + this.viewportHeight - 1);
            }
          }
          break;
      }
      return;
    }

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
      case 'Home': this.setCursor(0, this.cursor.y); break;
      case 'End': this.setCursor(this.buffer[this.cursor.y]?.length || 0, this.cursor.y); break;
      case 'PageUp': this.setCursor(this.cursor.x, this.cursor.y - this.viewportHeight); break;
      case 'PageDown': this.setCursor(this.cursor.x, this.cursor.y + this.viewportHeight); break;
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
    if (key === 'Home') { this.setCursor(0, this.cursor.y); return; }
    if (key === 'End') { this.setCursor(this.buffer[this.cursor.y]?.length || 0, this.cursor.y); return; }
    if (key === 'PageUp') { this.setCursor(this.cursor.x, this.cursor.y - this.viewportHeight); return; }
    if (key === 'PageDown') { this.setCursor(this.cursor.x, this.cursor.y + this.viewportHeight); return; }

    if (key === 'Backspace') {
      if (this.cursor.x > 0) {
        const line = this.buffer[this.cursor.y];
        this.buffer[this.cursor.y] = line.slice(0, this.cursor.x - 1) + line.slice(this.cursor.x);
        this.setCursor(this.cursor.x - 1, this.cursor.y);
      } else if (this.cursor.y > 0) {
        // Merge with previous line
        const prevLine = this.buffer[this.cursor.y - 1];
        const currentLine = this.buffer[this.cursor.y];
        const targetX = prevLine.length;
        this.buffer[this.cursor.y - 1] = prevLine + currentLine;
        this.buffer.splice(this.cursor.y, 1);
        this.setCursor(targetX, this.cursor.y - 1);
      }
    } else if (key === 'Enter') {
      const line = this.buffer[this.cursor.y];
      const left = line.slice(0, this.cursor.x);
      const right = line.slice(this.cursor.x);
      this.buffer[this.cursor.y] = left;
      this.buffer.splice(this.cursor.y + 1, 0, right);
      this.setCursor(0, this.cursor.y + 1);
    } else if (key.length === 1 && !_ctrl) {
      const line = this.buffer[this.cursor.y] || '';
      this.buffer[this.cursor.y] = line.slice(0, this.cursor.x) + key + line.slice(this.cursor.x);
      this.setCursor(this.cursor.x + 1, this.cursor.y);
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

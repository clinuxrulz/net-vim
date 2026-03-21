import { PluginManager } from './plugin-manager';
import type { VimMode, VimEvent, VimAPI, GutterOptions, CompletionItem, FileSystem, ContextMenuItem, VimState, LineRendererOptions, PickerItem, PickerOptions } from './types';
import { autoFS, PRELUDE_BASE } from './opfs-util';
import { loadScript } from './utils';

export class VimEngine {
  private buffer: string[] = ['Welcome to Net-Vim!', 'Press i to insert text', 'Press Esc to return to Normal mode', 'Type :q to quit'];
  private cursor = { x: 0, y: 0 };
  private visualStart: { x: number; y: number } | null = null;
  private topLine = 0;
  private leftCol = 0;
  private viewportHeight = 22;
  private viewportWidth = 80; // Default, will be updated by UI
  private mode: VimMode = 'Normal';
  private commandText = '';
  private commandCursorX = 0;
  private currentFilePath: string | null = null;
  private isExplorer = false;
  private explorerPath = '';
  private isReadOnly = false;
  private gutters: GutterOptions[] = [];
  private lineRenderers: LineRendererOptions[] = [];
  private contextMenuItems: ContextMenuItem[] = [];
  private commands: Record<string, (args: string[]) => void> = {};
  private onUpdate: () => void;
  private requestFocus: () => void;
  private eventListeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  private pluginManager: PluginManager;
  private fs: FileSystem = autoFS;
  private leader = ' '; // Set leader to space as requested
  private pendingSequence = '';
  private isInitialized = false;

  // Completion & Hover State
  private completionItems: CompletionItem[] = [];
  private selectedCompletionIndex = 0;
  private onCompletionSelect: ((item: CompletionItem) => void) | null = null;
  private hoverText: string | null = null;
  private hoverPos = { x: 0, y: 0 };
  private hoverScrollOffset = 0;
  private statusMessage: string | null = null;
  private messageTimeout: any = null;
  private wrap = true;
  private lineEnding: 'LF' | 'CRLF' = 'LF';

  // Picker State
  private pickerActive = false;
  private pickerQuery = '';
  private pickerItems: PickerItem[] = [];
  private pickerSelectedIndex = 0;
  private pickerPlaceholder = 'Search...';
  private pickerLoading = false;
  private pickerOptions: PickerOptions | null = null;
  private pickerDebounceTimeout: any = null;

  // Search State
  private lastSearchPattern = '';
  private lastSearchForward = true;

  constructor(onUpdate: () => void, requestFocus: () => void) {
    this.onUpdate = onUpdate;
    this.requestFocus = requestFocus;
    this.registerBuiltinCommands();
    this.pluginManager = new PluginManager(() => this.getAPI());
  }

  public async init() {
    if (this.isInitialized) return;
    
    // Load Babel Standalone
    try {
      await loadScript('https://unpkg.com/@babel/standalone/babel.min.js');
      console.log('[VimEngine] Babel Standalone loaded');
    } catch (err) {
      console.error('[VimEngine] Failed to load Babel Standalone:', err);
    }

    // Load help file if it's the default buffer
    if (this.buffer.length === 4 && this.buffer[0] === 'Welcome to Net-Vim!') {
      await this.openFile(PRELUDE_BASE + '/help.md');
    }
    
    this.isInitialized = true;
  }

  public setUpdateCallback(onUpdate: () => void) {
    this.onUpdate = onUpdate;
    this.onUpdate(); // Trigger immediately
  }

  public setRequestFocus(requestFocus: () => void) {
    this.requestFocus = requestFocus;
  }

  private registerBuiltinCommands() {
    this.commands['set'] = (args) => {
      const option = args[0];
      if (option === 'wrap') {
        this.wrap = true;
      } else if (option === 'nowrap') {
        this.wrap = false;
      } else if (option === 'wrap!') {
        this.wrap = !this.wrap;
      }
      this.onUpdate();
    };

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
        const joinStr = this.lineEnding === 'CRLF' ? '\r\n' : '\n';
        const content = this.buffer.join(joinStr);
        await this.fs.writeFile(targetPath, content);
        this.currentFilePath = targetPath;
        console.log(`"${targetPath}" saved (${this.lineEnding})`);
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

    this.commands['help'] = async () => {
      await this.openFile(PRELUDE_BASE + '/help.md');
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
      this.lineEnding = content.includes('\r\n') ? 'CRLF' : 'LF';
      this.buffer = content.replace(/\r\n/g, '\n').split('\n');
      this.currentFilePath = path;
      this.isExplorer = false;
      this.isReadOnly = path.startsWith(PRELUDE_BASE);
      this.cursor = { x: 0, y: 0 };
      this.trigger('TextChanged');
      this.trigger('BufferLoaded', { path, content });
      this.onUpdate();
      console.log(`Opened "${path}"${this.isReadOnly ? ' [ReadOnly]' : ''} (${this.lineEnding})`);
    } else {
      this.buffer = [''];
      this.lineEnding = 'LF'; // Default for new files
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
      requestFocus: () => this.requestFocus(),
      getCursor: () => ({ ...this.cursor }),
      setCursor: (x, y) => { this.setCursor(x, y); },
      getVisualStart: () => this.visualStart ? ({ ...this.visualStart }) : null,
      getMode: () => this.mode,
      getCurrentFilePath: () => this.currentFilePath,
      on: (event, callback) => {
        if (!this.eventListeners.has(event)) {
          this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(callback);
      },
      executeCommand: (cmd) => this.executeCommand(cmd),
      loadPluginFromSource: (name, source) => this.loadPluginFromSource(name, source),
      loadPlugin: (plugin) => this.loadPlugin(plugin),
      getLoadedPlugins: () => this.pluginManager.getLoadedPlugins(),
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
        this.hoverScrollOffset = 0;
        this.onUpdate();
      },
      hideHover: () => {
        this.hoverText = null;
        this.hoverScrollOffset = 0;
        this.onUpdate();
      },

      registerContextMenuItem: (item) => {
        this.contextMenuItems.push(item);
        this.contextMenuItems.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        this.onUpdate();
      },
      insertText: (text) => this.insertText(text),
      rerender: () => this.onUpdate(),

      showPicker: (options) => {
        this.pickerActive = true;
        this.pickerOptions = options;
        this.pickerQuery = '';
        this.pickerSelectedIndex = 0;
        this.pickerPlaceholder = options.placeholder || 'Search...';
        this.pickerItems = [];
        this.updatePickerResults();
        this.onUpdate();
      },
      hidePicker: () => {
        this.pickerActive = false;
        this.pickerOptions = null;
        this.onUpdate();
      },

      setFS: (fs) => { this.fs = fs; this.trigger('FSChanged'); this.onUpdate(); },
      getFS: () => this.fs,
      resetFS: () => { this.fs = autoFS; this.trigger('FSChanged'); this.onUpdate(); },
      babel: (window as any).Babel,
    };
  }

  private async updatePickerResults() {
    if (!this.pickerOptions) return;

    if (Array.isArray(this.pickerOptions.items)) {
      const query = this.pickerQuery.toLowerCase();
      this.pickerItems = this.pickerOptions.items.filter(item => 
        item.label.toLowerCase().includes(query) || (item.detail && item.detail.toLowerCase().includes(query))
      );
      this.pickerSelectedIndex = Math.min(this.pickerSelectedIndex, Math.max(0, this.pickerItems.length - 1));
      this.onUpdate();
    } else if (typeof this.pickerOptions.items === 'function') {
      this.pickerLoading = true;
      this.onUpdate();
      try {
        const results = await this.pickerOptions.items(this.pickerQuery);
        this.pickerItems = results;
        this.pickerSelectedIndex = Math.min(this.pickerSelectedIndex, Math.max(0, this.pickerItems.length - 1));
      } catch (err) {
        console.error('Picker error:', err);
      } finally {
        this.pickerLoading = false;
        this.onUpdate();
      }
    }
  }

  private insertText(text: string) {
    if (this.isReadOnly && this.mode !== 'Command') return;
    
    if (this.mode === 'Command') {
      const before = this.commandText.slice(0, this.commandCursorX);
      const after = this.commandText.slice(this.commandCursorX);
      const insertion = text.replace(/\r?\n/g, '');
      this.commandText = before + insertion + after;
      this.commandCursorX += insertion.length;
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
    if (this.wrap) {
      // In wrap mode, calculating if cursor is in view is more complex.
      // For now, let's at least ensure topLine is not after cursor.y
      if (this.cursor.y < this.topLine) {
        this.topLine = this.cursor.y;
      } else {
        // Calculate display rows from topLine to cursor.y
        let displayRows = 0;
        for (let i = this.topLine; i < this.cursor.y; i++) {
          displayRows += Math.max(1, Math.ceil((this.buffer[i]?.length || 0) / this.viewportWidth));
        }
        displayRows += Math.floor(this.cursor.x / this.viewportWidth);

        if (displayRows >= this.viewportHeight) {
          // Need to scroll down. We increment topLine until cursor is in view.
          while (displayRows >= this.viewportHeight && this.topLine < this.cursor.y) {
            displayRows -= Math.max(1, Math.ceil((this.buffer[this.topLine]?.length || 0) / this.viewportWidth));
            this.topLine++;
          }
        }
      }
    } else {
      if (this.cursor.y < this.topLine) {
        this.topLine = this.cursor.y;
      } else if (this.cursor.y >= this.topLine + this.viewportHeight) {
        this.topLine = this.cursor.y - this.viewportHeight + 1;
      }
    }

    // Horizontal
    if (this.wrap) {
      this.leftCol = 0;
    } else {
      if (this.cursor.x < this.leftCol) {
        this.leftCol = this.cursor.x;
      } else if (this.cursor.x >= this.leftCol + this.viewportWidth) {
        this.leftCol = this.cursor.x - this.viewportWidth + 1;
      }
    }
  }

  private trigger(event: VimEvent, ...args: any[]) {
    this.eventListeners.get(event)?.forEach(cb => cb(...args));
  }

  public async loadPluginFromSource(name: string, tsSource: string) {
    return this.pluginManager.loadPluginFromSource(name, tsSource);
  }

  public async loadPlugin(plugin: any) {
    return this.pluginManager.loadPlugin(plugin);
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
      buffer: [...this.buffer],
      cursor: { ...this.cursor },
      visualStart: this.visualStart ? { ...this.visualStart } : null,
      topLine: this.topLine,
      leftCol: this.leftCol,
      viewportHeight: this.viewportHeight,
      viewportWidth: this.viewportWidth,
      mode: this.mode,
      commandText: this.commandText,
      commandCursorX: this.commandCursorX,
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
      hoverScrollOffset: this.hoverScrollOffset,
      statusMessage: this.statusMessage,
      wrap: this.wrap,
      lineEnding: this.lineEnding,
      picker: this.pickerActive ? {
        active: true,
        query: this.pickerQuery,
        items: this.pickerItems,
        selectedIndex: this.pickerSelectedIndex,
        placeholder: this.pickerPlaceholder,
        loading: this.pickerLoading
      } : null,
    };
  }

  private showMessage(msg: string) {
    this.statusMessage = msg;
    if (this.messageTimeout) clearTimeout(this.messageTimeout);
    this.messageTimeout = setTimeout(() => {
      this.statusMessage = null;
      this.onUpdate();
    }, 3000);
    this.onUpdate();
  }

  public handleKey(key: string, _ctrl: boolean = false) {
    this.trigger('KeyDown', { key, ctrl: _ctrl });

    // Handle Picker if active
    if (this.pickerActive) {
      this.handlePickerKey(key, _ctrl);
      return;
    }

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
    } else if (this.mode === 'Search') {
      this.handleSearchMode(key, _ctrl);
    } else if (this.mode === 'Visual') {
      this.handleVisualMode(key, _ctrl);
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

  private handlePickerKey(key: string, ctrl: boolean) {
    if (key === 'Escape' || (key === 'c' && ctrl)) {
      if (this.pickerOptions?.onCancel) this.pickerOptions.onCancel();
      this.pickerActive = false;
      this.onUpdate();
      return;
    }

    if (key === 'ArrowDown' || (key === 'n' && ctrl) || (key === 'j' && ctrl)) {
      this.pickerSelectedIndex = (this.pickerSelectedIndex + 1) % Math.max(1, this.pickerItems.length);
      this.onUpdate();
      return;
    }

    if (key === 'ArrowUp' || (key === 'p' && ctrl) || (key === 'k' && ctrl)) {
      this.pickerSelectedIndex = (this.pickerSelectedIndex - 1 + this.pickerItems.length) % Math.max(1, this.pickerItems.length);
      this.onUpdate();
      return;
    }

    if (key === 'Enter') {
      const selected = this.pickerItems[this.pickerSelectedIndex];
      if (selected && this.pickerOptions?.onSelect) {
        this.pickerOptions.onSelect(selected);
      }
      this.pickerActive = false;
      this.onUpdate();
      return;
    }

    if (key === 'Backspace') {
      this.pickerQuery = this.pickerQuery.slice(0, -1);
      this.debouncedPickerUpdate();
      this.onUpdate();
      return;
    }

    if (key.length === 1 && !ctrl) {
      this.pickerQuery += key;
      this.debouncedPickerUpdate();
      this.onUpdate();
      return;
    }
  }

  private debouncedPickerUpdate() {
    if (this.pickerDebounceTimeout) clearTimeout(this.pickerDebounceTimeout);
    this.pickerDebounceTimeout = setTimeout(() => {
      this.updatePickerResults();
    }, 150);
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

  private async putFromClipboard(after: boolean = true) {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;

      if (this.mode === 'Visual') {
        this.deleteSelection();
        this.insertText(text);
        this.mode = 'Normal';
        this.visualStart = null;
      } else {
        // Normal mode
        const endsWithNewline = text.endsWith('\n');
        if (endsWithNewline) {
          // Put below/above line
          const targetLine = after ? this.cursor.y + 1 : this.cursor.y;
          const lines = text.split('\n');
          if (lines[lines.length - 1] === '') lines.pop();
          this.buffer.splice(targetLine, 0, ...lines);
          this.setCursor(0, targetLine);
        } else {
          // Put after/before cursor
          const currentLine = this.buffer[this.cursor.y] || '';
          const insertPos = after ? Math.min(currentLine.length, this.cursor.x + 1) : this.cursor.x;
          
          const lines = text.split('\n');
          const before = currentLine.slice(0, insertPos);
          const afterPart = currentLine.slice(insertPos);

          if (lines.length === 1) {
            this.buffer[this.cursor.y] = before + lines[0] + afterPart;
            this.setCursor(insertPos + lines[0].length - 1, this.cursor.y);
          } else {
            this.buffer[this.cursor.y] = before + lines[0];
            const middle = lines.slice(1, -1);
            const last = lines[lines.length - 1] + afterPart;
            const newLines = [this.buffer[this.cursor.y], ...middle, last];
            this.buffer.splice(this.cursor.y, 1, ...newLines);
            this.setCursor(lines[lines.length - 1].length - 1, this.cursor.y + lines.length - 1);
          }
        }
      }
      this.trigger('TextChanged');
      this.onUpdate();
    } catch (err) {
      this.showMessage('Failed to read from clipboard');
      console.error(err);
    }
  }

  private handleNormalMode(key: string, ctrl: boolean) {
    let currentSeq = this.pendingSequence;
    if (ctrl) {
      currentSeq += 'Ctrl-' + key;
    } else if (key === this.leader) {
      currentSeq += 'leader';
    } else {
      currentSeq += key;
    }

    // Check for sequences
    if (currentSeq === 'Ctrl-w') {
      this.pendingSequence = 'Ctrl-w';
      return;
    }
    if (currentSeq === 'Ctrl-wd') {
      this.pendingSequence = '';
      this.executeCommand('showDiagnostics');
      return;
    }

    if (currentSeq === 'leader') {
      this.pendingSequence = 'leader';
      return;
    }
    if (currentSeq === 'leaderd') {
      this.pendingSequence = '';
      this.executeCommand('showDiagnostics');
      return;
    }
    if (currentSeq === 'leadere') {
      this.pendingSequence = '';
      this.executeCommand('hover');
      return;
    }
    if (currentSeq === 'leaderf') {
      this.pendingSequence = 'leaderf';
      return;
    }
    if (currentSeq === 'leaderff') {
      this.pendingSequence = '';
      this.executeCommand('fuzzyFiles');
      return;
    }
    if (currentSeq === 'leaderfg') {
      this.pendingSequence = '';
      this.executeCommand('liveGrep');
      return;
    }

    if (currentSeq === '[') {
      this.pendingSequence = '[';
      return;
    }
    if (currentSeq === '[d') {
      this.pendingSequence = '';
      this.executeCommand('prevDiagnostic');
      return;
    }

    if (currentSeq === ']') {
      this.pendingSequence = ']';
      return;
    }
    if (currentSeq === ']d') {
      this.pendingSequence = '';
      this.executeCommand('nextDiagnostic');
      return;
    }

    if (currentSeq === 'y') {
      this.pendingSequence = 'y';
      return;
    }
    if (currentSeq === 'yy') {
      this.pendingSequence = '';
      const line = this.buffer[this.cursor.y] || '';
      this.yankToClipboard(line + '\n');
      return;
    }

    if (currentSeq === 'd') {
      this.pendingSequence = 'd';
      return;
    }
    if (currentSeq === 'dd') {
      this.pendingSequence = '';
      const line = this.buffer[this.cursor.y] || '';
      this.yankToClipboard(line + '\n');
      this.buffer.splice(this.cursor.y, 1);
      if (this.buffer.length === 0) this.buffer = [''];
      this.setCursor(this.cursor.x, this.cursor.y);
      this.trigger('TextChanged');
      return;
    }

    if (currentSeq === '>') {
      this.pendingSequence = '>';
      return;
    }
    if (currentSeq === '>>') {
      this.pendingSequence = '';
      this.indentLine(this.cursor.y);
      this.trigger('TextChanged');
      return;
    }

    if (currentSeq === '<') {
      this.pendingSequence = '<';
      return;
    }
    if (currentSeq === '<<') {
      this.pendingSequence = '';
      this.deindentLine(this.cursor.y);
      this.trigger('TextChanged');
      return;
    }

    // If we're here and have a pending sequence, but no match, reset it
    // unless the current key might start a new sequence.
    if (this.pendingSequence !== '') {
      this.pendingSequence = '';
      // If we didn't match anything with the full sequence, 
      // try handling the current key as a fresh start.
      this.handleNormalMode(key, ctrl);
      return;
    }

    if (this.hoverText && ctrl) {
      if (key === 'd' || key === 'e') {
        this.hoverScrollOffset += (key === 'd' ? 5 : 1);
        this.onUpdate();
        return;
      }
      if (key === 'u' || key === 'y') {
        this.hoverScrollOffset = Math.max(0, this.hoverScrollOffset - (key === 'u' ? 5 : 1));
        this.onUpdate();
        return;
      }
    }

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
      case 'v': 
        if (this.mode === 'Visual') {
          this.mode = 'Normal';
          this.visualStart = null;
        } else {
          this.mode = 'Visual'; 
          this.visualStart = { ...this.cursor };
        }
        break;
      case ':': this.mode = 'Command'; this.commandText = ''; this.commandCursorX = 0; break;
      case '/': 
        this.mode = 'Search'; 
        this.commandText = ''; 
        this.commandCursorX = 0; 
        this.lastSearchForward = true;
        break;
      case '?': 
        this.mode = 'Search'; 
        this.commandText = ''; 
        this.commandCursorX = 0; 
        this.lastSearchForward = false;
        break;
      case 'n': this.repeatSearch(this.lastSearchForward); break;
      case 'N': this.repeatSearch(!this.lastSearchForward); break;
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
      case 'p': this.putFromClipboard(true); break;
      case 'P': this.putFromClipboard(false); break;
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

  private handleVisualMode(key: string, _ctrl: boolean) {
    if (key === 'Escape') {
      this.mode = 'Normal';
      this.visualStart = null;
      return;
    }

    switch (key) {
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
      case 'v':
        this.mode = 'Normal';
        this.visualStart = null;
        break;
      case 'p':
        this.putFromClipboard(true);
        break;
      case 'd':
      case 'x':
        const selectedText = this.getSelectionText();
        this.yankToClipboard(selectedText);
        this.deleteSelection();
        this.mode = 'Normal';
        this.visualStart = null;
        break;
      case 'y':
        const text = this.getSelectionText();
        this.yankToClipboard(text);
        this.mode = 'Normal';
        this.visualStart = null;
        break;
      case '>':
        this.indentSelection();
        this.mode = 'Normal';
        this.visualStart = null;
        break;
      case '<':
        this.deindentSelection();
        this.mode = 'Normal';
        this.visualStart = null;
        break;
    }
  }

  private indentLine(y: number) {
    if (y < 0 || y >= this.buffer.length) return;
    this.buffer[y] = '  ' + this.buffer[y];
    const firstNonBlank = this.buffer[y].search(/\S/);
    this.setCursor(firstNonBlank !== -1 ? firstNonBlank : 0, y);
  }

  private deindentLine(y: number) {
    if (y < 0 || y >= this.buffer.length) return;
    const line = this.buffer[y];
    let spacesToRemove = 0;
    if (line.startsWith('  ')) spacesToRemove = 2;
    else if (line.startsWith(' ')) spacesToRemove = 1;
    
    if (spacesToRemove > 0) {
      this.buffer[y] = line.slice(spacesToRemove);
    }
    const firstNonBlank = this.buffer[y].search(/\S/);
    this.setCursor(firstNonBlank !== -1 ? firstNonBlank : 0, y);
  }

  private indentSelection() {
    if (!this.visualStart) return;
    let startY = Math.min(this.visualStart.y, this.cursor.y);
    let endY = Math.max(this.visualStart.y, this.cursor.y);
    for (let y = startY; y <= endY; y++) {
      if (y < 0 || y >= this.buffer.length) continue;
      this.buffer[y] = '  ' + this.buffer[y];
    }
    const firstNonBlank = this.buffer[startY].search(/\S/);
    this.setCursor(firstNonBlank !== -1 ? firstNonBlank : 0, startY);
    this.trigger('TextChanged');
  }

  private deindentSelection() {
    if (!this.visualStart) return;
    let startY = Math.min(this.visualStart.y, this.cursor.y);
    let endY = Math.max(this.visualStart.y, this.cursor.y);
    for (let y = startY; y <= endY; y++) {
      if (y < 0 || y >= this.buffer.length) continue;
      const line = this.buffer[y];
      let spacesToRemove = 0;
      if (line.startsWith('  ')) spacesToRemove = 2;
      else if (line.startsWith(' ')) spacesToRemove = 1;
      if (spacesToRemove > 0) {
        this.buffer[y] = line.slice(spacesToRemove);
      }
    }
    const firstNonBlank = this.buffer[startY].search(/\S/);
    this.setCursor(firstNonBlank !== -1 ? firstNonBlank : 0, startY);
    this.trigger('TextChanged');
  }

  private async yankToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      if (lineCount > 1) {
        this.showMessage(`${lineCount} lines yanked`);
      } else {
        this.showMessage(`Yanked ${text.length} characters`);
      }
    } catch (err) {
      this.showMessage(`Failed to copy to clipboard`);
      console.error('Failed to copy to clipboard:', err);
    }
  }

  private getSelectionText(): string {
    if (!this.visualStart) return '';

    let start = this.visualStart;
    let end = this.cursor;

    // Normalize start/end
    if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
      [start, end] = [end, start];
    }

    if (start.y === end.y) {
      return this.buffer[start.y].slice(start.x, end.x + 1);
    } else {
      const selectedLines = [];
      selectedLines.push(this.buffer[start.y].slice(start.x));
      for (let i = start.y + 1; i < end.y; i++) {
        selectedLines.push(this.buffer[i]);
      }
      selectedLines.push(this.buffer[end.y].slice(0, end.x + 1));
      return selectedLines.join('\n');
    }
  }

  private deleteSelection() {
    if (!this.visualStart) return;

    let start = this.visualStart;
    let end = this.cursor;

    // Normalize start/end
    if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
      [start, end] = [end, start];
    }

    if (start.y === end.y) {
      const line = this.buffer[start.y];
      this.buffer[start.y] = line.slice(0, start.x) + line.slice(end.x + 1);
      this.setCursor(start.x, start.y);
    } else {
      const startLine = this.buffer[start.y];
      const endLine = this.buffer[end.y];
      
      this.buffer[start.y] = startLine.slice(0, start.x) + endLine.slice(end.x + 1);
      this.buffer.splice(start.y + 1, end.y - start.y);
      this.setCursor(start.x, start.y);
    }
    this.trigger('TextChanged');
  }

  private handleCommandMode(key: string, _ctrl: boolean) {
    if (key === 'Escape') {
      this.mode = 'Normal';
      this.commandText = '';
      this.commandCursorX = 0;
    } else if (key === 'Enter') {
      this.executeCommand(this.commandText);
      this.mode = 'Normal';
      this.commandText = '';
      this.commandCursorX = 0;
    } else if (key === 'Backspace') {
      if (this.commandCursorX > 0) {
        const before = this.commandText.slice(0, this.commandCursorX - 1);
        const after = this.commandText.slice(this.commandCursorX);
        this.commandText = before + after;
        this.commandCursorX--;
      } else if (this.commandText.length === 0) {
        this.mode = 'Normal';
      }
    } else if (key === 'Delete') {
      if (this.commandCursorX < this.commandText.length) {
        const before = this.commandText.slice(0, this.commandCursorX);
        const after = this.commandText.slice(this.commandCursorX + 1);
        this.commandText = before + after;
      }
    } else if (key === 'ArrowLeft') {
      this.commandCursorX = Math.max(0, this.commandCursorX - 1);
    } else if (key === 'ArrowRight') {
      this.commandCursorX = Math.min(this.commandText.length, this.commandCursorX + 1);
    } else if (key === 'Home') {
      this.commandCursorX = 0;
    } else if (key === 'End') {
      this.commandCursorX = this.commandText.length;
    } else if (key.length === 1 && !_ctrl) {
      const before = this.commandText.slice(0, this.commandCursorX);
      const after = this.commandText.slice(this.commandCursorX);
      this.commandText = before + key + after;
      this.commandCursorX++;
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

  private handleSearchMode(key: string, _ctrl: boolean) {
    if (key === 'Escape') {
      this.mode = 'Normal';
      this.commandText = '';
      this.commandCursorX = 0;
    } else if (key === 'Enter') {
      if (this.commandText) {
        this.lastSearchPattern = this.commandText;
      }
      if (this.lastSearchPattern) {
        this.repeatSearch(this.lastSearchForward);
      }
      this.mode = 'Normal';
      this.commandText = '';
      this.commandCursorX = 0;
    } else if (key === 'Backspace') {
      if (this.commandCursorX > 0) {
        const before = this.commandText.slice(0, this.commandCursorX - 1);
        const after = this.commandText.slice(this.commandCursorX);
        this.commandText = before + after;
        this.commandCursorX--;
      } else if (this.commandText.length === 0) {
        this.mode = 'Normal';
      }
    } else if (key === 'Delete') {
      if (this.commandCursorX < this.commandText.length) {
        const before = this.commandText.slice(0, this.commandCursorX);
        const after = this.commandText.slice(this.commandCursorX + 1);
        this.commandText = before + after;
      }
    } else if (key === 'ArrowLeft') {
      this.commandCursorX = Math.max(0, this.commandCursorX - 1);
    } else if (key === 'ArrowRight') {
      this.commandCursorX = Math.min(this.commandText.length, this.commandCursorX + 1);
    } else if (key === 'Home') {
      this.commandCursorX = 0;
    } else if (key === 'End') {
      this.commandCursorX = this.commandText.length;
    } else if (key.length === 1 && !_ctrl) {
      const before = this.commandText.slice(0, this.commandCursorX);
      const after = this.commandText.slice(this.commandCursorX);
      this.commandText = before + key + after;
      this.commandCursorX++;
    }
  }

  private repeatSearch(forward: boolean) {
    if (!this.lastSearchPattern) return;

    try {
      const regex = new RegExp(this.lastSearchPattern, 'g');
      let found = false;

      if (forward) {
        // Search forward
        for (let y = this.cursor.y; y < this.buffer.length; y++) {
          const line = this.buffer[y];
          const startX = y === this.cursor.y ? this.cursor.x + 1 : 0;
          if (startX >= line.length && y === this.cursor.y) continue;
          
          regex.lastIndex = startX;
          const match = regex.exec(line);
          if (match) {
            this.setCursor(match.index, y);
            found = true;
            break;
          }
        }
        
        if (!found) { // Wrap around
          for (let y = 0; y <= this.cursor.y; y++) {
            const line = this.buffer[y];
            regex.lastIndex = 0;
            const match = regex.exec(line);
            if (match) {
              if (y === this.cursor.y && match.index > this.cursor.x) continue; // Already checked
              this.setCursor(match.index, y);
              found = true;
              break;
            }
          }
        }
      } else {
        // Search backward
        for (let y = this.cursor.y; y >= 0; y--) {
          const line = this.buffer[y];
          const endLimit = y === this.cursor.y ? this.cursor.x - 1 : line.length;
          
          let lastMatchIndex = -1;
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(line)) !== null) {
            if (match.index > endLimit) break;
            lastMatchIndex = match.index;
            if (regex.lastIndex === match.index) regex.lastIndex++;
          }
          
          if (lastMatchIndex !== -1) {
            this.setCursor(lastMatchIndex, y);
            found = true;
            break;
          }
        }

        if (!found) { // Wrap around from bottom
          for (let y = this.buffer.length - 1; y >= this.cursor.y; y--) {
            const line = this.buffer[y];
            let lastMatchIndex = -1;
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(line)) !== null) {
              if (y === this.cursor.y && match.index >= this.cursor.x) break;
              lastMatchIndex = match.index;
              if (regex.lastIndex === match.index) regex.lastIndex++;
            }
            
            if (lastMatchIndex !== -1) {
              this.setCursor(lastMatchIndex, y);
              found = true;
              break;
            }
          }
        }
      }

      if (!found) {
        this.showMessage('Pattern not found: ' + this.lastSearchPattern);
      }
    } catch (err) {
      this.showMessage('Invalid pattern: ' + this.lastSearchPattern);
    }
  }
}

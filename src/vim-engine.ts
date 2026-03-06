export type VimMode = 'Normal' | 'Insert' | 'Command';

export interface VimPlugin {
  name: string;
  init: (api: VimAPI) => void;
}

export interface VimAPI {
  registerCommand: (name: string, callback: (args: string[]) => void) => void;
  getBuffer: () => string[];
  setBuffer: (buffer: string[]) => void;
  getCursor: () => { x: number, y: number };
  setCursor: (x: number, y: number) => void;
  getMode: () => VimMode;
}

export class VimEngine {
  private buffer: string[] = ['Welcome to Web-Vim!', 'Press i to insert text', 'Press Esc to return to Normal mode', 'Type :q to quit'];
  private cursor = { x: 0, y: 0 };
  private mode: VimMode = 'Normal';
  private commandText = '';
  private commands: Record<string, (args: string[]) => void> = {};
  private onUpdate: () => void;

  constructor(onUpdate: () => void) {
    this.onUpdate = onUpdate;
    this.registerBuiltinCommands();
  }

  private registerBuiltinCommands() {
    this.commands['q'] = () => {
      console.log('Quitting...');
      // In a real app, this might close the window or clear the buffer
    };
    this.commands['w'] = () => {
      console.log('Saving...');
    };
  }

  public getAPI(): VimAPI {
    return {
      registerCommand: (name, callback) => { this.commands[name] = callback; },
      getBuffer: () => [...this.buffer],
      setBuffer: (buffer: string[]) => { this.buffer = [...buffer]; this.onUpdate(); },
      getCursor: () => ({ ...this.cursor }),
      setCursor: (x, y) => { this.cursor = { x, y }; this.onUpdate(); },
      getMode: () => this.mode,
    };
  }

  public getState() {
    return {
      buffer: this.buffer,
      cursor: this.cursor,
      mode: this.mode,
      commandText: this.commandText,
    };
  }

  public handleKey(key: string, _ctrl: boolean = false) {
    if (this.mode === 'Normal') {
      this.handleNormalMode(key, _ctrl);
    } else if (this.mode === 'Insert') {
      this.handleInsertMode(key, _ctrl);
    } else if (this.mode === 'Command') {
      this.handleCommandMode(key, _ctrl);
    }
    this.onUpdate();
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

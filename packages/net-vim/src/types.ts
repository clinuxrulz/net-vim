declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      'tui-box': any;
      'tui-text': any;
      'text': any;
      'box': any;
    }
  }
}

export const TYPES_VERSION = '1.0.0';

export type VimMode = 'Normal' | 'Insert' | 'Command' | 'Visual' | 'Search';

export type VimEvent = 'ModeChanged' | 'CursorMoved' | 'TextChanged' | 'BufferLoaded' | 'FileChanged' | 'FileDeleted' | 'KeyDown' | 'FSChanged';

export interface CompletionItem {
  label: string;
  kind?: string;
  detail?: string;
  documentation?: string;
}

export interface ContextMenuItem {
  label: string;
  action: () => void;
  priority?: number;
}

export interface GutterOptions {
  name: string;
  width: number;
  priority?: number;
  /**
   * A function that returns a TUI element for a given line.
   * Plugins can use the provided 'h' function to create elements.
   */
  render: (props: { 
    lineIndex: number | (() => number); 
    lineContent: string | (() => string); 
    isCursorLine: boolean | (() => boolean) 
  }) => any;
}

export interface LineRendererOptions {
  name: string;
  priority?: number;
  render: (props: { 
    lineIndex: number | (() => number); 
    lineContent: string | (() => string); 
    isCursorLine: boolean | (() => boolean) 
    gutterWidth: number | (() => number)
    leftCol: number | (() => number)
    viewportWidth: number | (() => number)
    visualStart?: { x: number; y: number } | null | (() => { x: number; y: number } | null);
    mode?: VimMode | (() => VimMode);
    cursor?: { x: number; y: number } | (() => { x: number; y: number });
    currentFilePath?: string | null | (() => string | null);
  }) => any;
}

export interface PickerItem {
  label: string;
  detail?: string;
  id?: string;
}

export interface PickerOptions {
  items: PickerItem[] | ((query: string) => Promise<PickerItem[]>);
  onSelect: (item: PickerItem) => void;
  onCancel?: () => void;
  placeholder?: string;
}

export interface VimState {
  buffer: string[];
  cursor: { x: number; y: number };
  visualStart: { x: number; y: number } | null;
  topLine: number;
  leftCol: number;
  viewportHeight: number;
  viewportWidth: number;
  mode: VimMode;
  commandText: string;
  commandCursorX: number;
  currentFilePath: string | null;
  isExplorer: boolean;
  explorerPath: string;
  isReadOnly: boolean;
  plugins: any[];
  gutters: GutterOptions[];
  lineRenderers: LineRendererOptions[];
  contextMenuItems: ContextMenuItem[];
  completionItems: CompletionItem[];
  selectedCompletionIndex: number;
  hoverText: string | null;
  hoverPos: { x: number; y: number };
  hoverScrollOffset: number;
  statusMessage: string | null;
  wrap: boolean;
  lineEnding: 'LF' | 'CRLF';
  picker: {
    active: boolean;
    query: string;
    items: PickerItem[];
    selectedIndex: number;
    placeholder: string;
    loading: boolean;
  } | null;
}

export interface FileSystem {
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
  listDirectory: (path: string) => Promise<string[]>;
  isDirectory: (path: string) => Promise<boolean>;
}

export interface VimAPI {
  registerCommand: (name: string, callback: (args: string[]) => void) => void;
  getBuffer: () => string[];
  setBuffer: (buffer: string[]) => void;
  requestFocus: () => void,
  getCursor: () => { x: number, y: number };
  setCursor: (x: number, y: number) => void;
  getVisualStart: () => { x: number, y: number } | null;
  getMode: () => VimMode;
  getCurrentFilePath: () => string | null;
  on: (event: VimEvent, callback: (...args: any[]) => void) => void;
  executeCommand: (cmd: string) => void;
  loadPluginFromSource: (name: string, source: string) => Promise<boolean>;
  loadPlugin: (plugin: any) => Promise<boolean>;
  getLoadedPlugins: () => any[];
  registerGutter: (options: GutterOptions) => void;
  registerLineRenderer: (options: LineRendererOptions) => void;
  
  // UI Overlays
  showCompletions: (items: CompletionItem[], onSelect: (item: CompletionItem) => void) => void;
  hideCompletions: () => void;
  showHover: (text: string, x: number, y: number) => void;
  hideHover: () => void;
  registerContextMenuItem: (item: ContextMenuItem) => void;
  insertText: (text: string) => void;
  rerender: () => void;

  // Picker API
  showPicker: (options: PickerOptions) => void;
  hidePicker: () => void;

  // File System
  setFS: (fs: FileSystem) => void;
  getFS: () => FileSystem;
  resetFS: () => void;

  // Tools
  babel: any;
}

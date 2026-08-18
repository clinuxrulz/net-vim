import { createSignal, onMount, Show, createEffect, For, onCleanup, batch } from 'solid-js';
import { render } from './solid-universal-tui';
import { WebGLRenderer } from './WebGLRenderer';
import { DOMRenderer } from './DOMRenderer';
import { VimEngine } from './vim-engine';
import { VimUI } from './VimUI';
import type { VimState } from './types';
import { autoFS, PRELUDE_BASE } from './opfs-util';
import { VirtualKeyboard } from '@net-vim/virtual-keyboard';
// @ts-ignore
import init, { Engine } from './wasm/tui_engine';

export const CONFIG_PATH = '.config/net-vim/init.ts';
export const CONFIG_LUA_PATH = '.config/net-vim/init.lua';

export const DEFAULT_LUA_INIT = `
-- Net-Vim Lua configuration (runs after init.ts).
-- Enables tree-sitter syntax highlighting and a small set of Lua plugins.

-- Enable tree-sitter highlighting automatically for supported file types.
local function enable_ts()
  pcall(vim.treesitter.start, 0)
end
vim.api.nvim_create_autocmd({ 'BufReadPost' }, { callback = enable_ts })

-- Manual toggle available via :ts or :lua vim.treesitter.start()/stop()

-- Test command: does :LuaHello
vim.api.nvim_create_user_command('LuaHello', function()
  local fname = vim.fn.expand('%')
  vim.api.nvim_notify('Lua plugin runtime is alive. Editing: ' .. tostring(fname), 0, {})
end, {})

-- Test command: does :TsTest -> reports whether tree-sitter is highlighting
vim.api.nvim_create_user_command('TsTest', function()
  local ok = pcall(vim.treesitter.start, 0)
  vim.api.nvim_notify('treesitter highlight: ' .. tostring(ok), 0, {})
end, {})

-- Sample leader keymap: <space>l runs :LuaHello
vim.keymap.set('n', '<leader>l', function()
  vim.api.nvim_command('LuaHello')
end, {})
`;

export const DEFAULT_INIT = `
export default {
  metadata: {
    name: "user-init",
    description: "User startup configuration"
  },
  setup: async (api) => {
    api.log("Custom init.ts loaded!");
    
    // Load built-in plugins from the virtual prelude if desired:
    const lineNumbers = await api.configFs.readFile(".config/net-vim/prelude/line-numbers.tsx");
    if (lineNumbers) {
      await api.loadPluginFromSource("line-numbers", lineNumbers);
    }
    
    const contextMenu = await api.configFs.readFile(".config/net-vim/prelude/context-menu.tsx");
    if (contextMenu) {
      await api.loadPluginFromSource("context-menu", contextMenu);
    }

    const tsLsp = await api.configFs.readFile(".config/net-vim/prelude/ts-lsp.tsx");
    if (tsLsp) {
      await api.loadPluginFromSource("ts-lsp", tsLsp);
    }

    const externalFs = await api.configFs.readFile(".config/net-vim/prelude/external-fs.tsx");
    if (externalFs) {
      await api.loadPluginFromSource("external-fs", externalFs);
    }

    const eruda = await api.configFs.readFile(".config/net-vim/prelude/eruda.tsx");
    if (eruda) {
      await api.loadPluginFromSource("eruda", eruda);
    }

    const markdownSyntax = await api.configFs.readFile(".config/net-vim/prelude/markdown-syntax.tsx");
    if (markdownSyntax) {
      await api.loadPluginFromSource("markdown-syntax", markdownSyntax);
    }

    const fuzzyFinder = await api.configFs.readFile(".config/net-vim/prelude/fuzzy-finder.tsx");
    if (fuzzyFinder) {
      await api.loadPluginFromSource("fuzzy-finder", fuzzyFinder);
    }

    const sshTerminal = await api.configFs.readFile(".config/net-vim/prelude/ssh-terminal.tsx");
    if (sshTerminal) {
      await api.loadPluginFromSource("ssh-terminal", sshTerminal);
    }
  }
};
`;

const PROP_TO_TYPE_MAP = new Map([
  ['x', "number"],
  ['y', "number"],
  ['width', "number"],
  ['height', "number"],
]);

const TYPE_PARSER_MAP = new Map([
  ["number", (x: string) => Number.parseFloat(x)]
]);

// Character size for grid calculation - now reactive signals
const [charSize, setCharSize] = createSignal({ width: 10, height: 20 });

export default function VimEditor(props: { engine?: VimEngine, ref?: (engine: VimEngine) => void, autoCreateInit?: boolean }) {
  const [gridDim, setGridDim] = createSignal({ width: 80, height: 24 });
  const [isMobile, setIsMobile] = createSignal(false);
  const [showKeyboard, setShowKeyboard] = createSignal(false);
  const [sysKbOpen, setSysKbOpen] = createSignal(false);
  const [crtEnabled, setCrtEnabled] = createSignal(false);
  const [rendererMode, setRendererMode] = createSignal<'webgl' | 'dom'>('webgl');
  const [contextMenu, setContextMenu] = createSignal<{ x: number, y: number, items: any[] } | null>(null);

  let [ hasFocus, setHasFocus, ] = createSignal(false);
  
  const [visualCursor, setVisualCursor] = createSignal({ x: 0, y: 0 });

  const [renderData, setRenderData] = createSignal({
    chars: new Uint8Array(80 * 24),
    fgs: new Uint8Array(80 * 24 * 3),
    bgs: new Uint8Array(80 * 24 * 3),
  });

  const [vimState, setVimState] = createSignal<VimState>({
    buffer: [] as string[],
    cursor: { x: 0, y: 0 },
    visualStart: null,
    topLine: 0,
    leftCol: 0,
    viewportHeight: 22,
    viewportWidth: 80,
    mode: 'Normal',
    commandText: '',
    currentFilePath: null,
    isExplorer: false,
    explorerPath: '',
    isReadOnly: false,
    plugins: [],
    gutters: [],
    lineRenderers: [],
    contextMenuItems: [],
    completionItems: [],
    selectedCompletionIndex: 0,
    hoverText: null,
    hoverPos: { x: 0, y: 0 },
    hoverScrollOffset: 0,
    statusMessage: null,
    commandCursorX: 0,
    wrap: false,
    lineEnding: 'LF',
    picker: null,
  });

  let containerRef: HTMLDivElement | undefined;
  let rustEngine: Engine | null = null;
  let vimInstance: VimEngine | null = props.engine || null;

  // Hidden contenteditable used to summon the native/system virtual keyboard
  let sysKbInputRef: HTMLDivElement | undefined;
  let sysKbComposing = false;
  // Set when a keydown was handled for a press, so a platform that still fires
  // `beforeinput` afterwards can't double-dispatch the same key.
  let sysKbPendingKeyDown = false;
  // Running composed text so autocomplete/IME letters can be applied to vim
  // incrementally (CodeMirror-style), instead of only on compositionend.
  let sysKbLastComposed = '';

  // Variables for touch interaction (pinch-to-zoom and scrolling)
  let initialPinchDistance = 0;
  let initialCharSize = { width: 10, height: 20 };
  let lastTouchY = 0;
  let touchScrollAccumulator = 0;

  const updateDimensions = () => {
    if (!containerRef) return;
    const currentSize = charSize();
    const width = Math.max(10, Math.floor(containerRef.clientWidth / currentSize.width));
    const height = Math.max(5, Math.floor(containerRef.clientHeight / currentSize.height));
    
    if (width !== gridDim().width || height !== gridDim().height) {
      setGridDim({ width, height });
      if (rustEngine) {
        rustEngine = new Engine(width, height);
      }
      if (vimInstance) {
        const totalGutterWidth = vimState().gutters.reduce((acc, g) => acc + g.width, 0);
        vimInstance.setViewportHeight(height - 2);
        vimInstance.setViewportWidth(width - totalGutterWidth);
        setVimState(vimInstance.getState());
      }
    }
  };

  onMount(async () => {
    // Detect mobile
    const checkMobile = () => {
      const mobile = window.matchMedia('(pointer: coarse)').matches || 
                     /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobile(mobile);
    };
    checkMobile();

    try {
      await init();
      
      const onUpdate = () => {
        if (vimInstance) {
          setVimState(vimInstance.getState());
        }
      };

      const requestFocus = () => {
        containerRef?.focus();
      };

      if (props.engine) {
        vimInstance = props.engine;
        vimInstance.setUpdateCallback(onUpdate);
      } else {
        vimInstance = new VimEngine(onUpdate, requestFocus);
      }
      
      await vimInstance.init();
      
      if (props.ref) {
        props.ref(vimInstance);
      }
      
      // Initialize Engine after WASM init
      rustEngine = new Engine(gridDim().width, gridDim().height);

      // Initial sizing
      updateDimensions();
      const initialGutterWidth = vimInstance.getState().gutters.reduce((acc: number, g: any) => acc + g.width, 0);
      vimInstance.setViewportHeight(gridDim().height - 2);
      vimInstance.setViewportWidth(gridDim().width - initialGutterWidth);

      // Initialize Plugins
      
      // 1. Check FS for init.ts (if not already loaded by initNetVim)
      if (!vimInstance.getAPI().getLoadedPlugins().some(p => p.name === 'user-init' || p.name === 'init.ts')) {
        try {
          let initSource = await autoFS.readFile(CONFIG_PATH);
          
          if (!initSource && props.autoCreateInit) {
            console.log("[VimEditor] Auto-creating default init.ts at", CONFIG_PATH);
            await autoFS.writeFile(CONFIG_PATH, DEFAULT_INIT);
            initSource = await autoFS.readFile(CONFIG_PATH);
          }

          if (initSource) {
            await vimInstance.loadPluginFromSource("init.ts", initSource);
          }
        } catch (e) {
          console.error("Error loading init.ts:", e);
        }
      }

      // 1b. Load Neovim-style init.lua (plus any lua/ modules for require)
      const luaInit = await autoFS.readFile('.config/net-vim/init.lua');
      if (luaInit) {
        try {
          await vimInstance.loadLuaPluginFromSource("init.lua", luaInit);
        } catch (e) {
          console.error("Error loading init.lua:", e);
        }
      }
      
      // Register CRT toggle command
      const runtime = vimInstance!;
      vimInstance.getAPI().registerCommand('crt', () => {
        setCrtEnabled(!crtEnabled());
      });

      // Register renderer switch command: :renderer dom|webgl (bare toggles)
      vimInstance.getAPI().registerCommand('renderer', (args) => {
        const target = (args[0] || '').toLowerCase();
        if (target === 'dom') setRendererMode('dom');
        else if (target === 'webgl') setRendererMode('webgl');
        else setRendererMode(rendererMode() === 'webgl' ? 'dom' : 'webgl');
      });

      // Register toggle for the native/system virtual keyboard (:syskb)
      vimInstance.getAPI().registerCommand('syskb', () => {
        if (sysKbOpen()) {
          closeSysKb();
        } else {
          openSysKb();
        }
      });

      // Command to create a default init.ts if missing
      vimInstance.getAPI().registerCommand('create-init', async () => {
        await autoFS.writeFile(CONFIG_PATH, DEFAULT_INIT);
        console.log("Created default init.ts at", CONFIG_PATH);
      });

      // Command to create a starter init.lua (Lua plugins + treesitter)
      vimInstance.getAPI().registerCommand('create-lua-init', async () => {
        await autoFS.writeFile(CONFIG_LUA_PATH, DEFAULT_LUA_INIT);
        console.log("Created default init.lua at", CONFIG_LUA_PATH);
        runtime.getAPI().showMessage('Created init.lua - reload to apply');
      });

      // Evaluate a Lua snippet in the embedded Lua VM: :lua <code>
      vimInstance.getAPI().registerCommand('lua', async (args) => {
        const source = args.join(' ');
        if (!source.trim()) {
          runtime.getAPI().showMessage(':lua <code>');
          return;
        }
        try {
          const result = await runtime.evalLua(source);
          if (result !== undefined && result !== null) {
            console.log('[lua]', result);
            runtime.getAPI().showMessage(String(result));
          }
        } catch (err) {
          console.error('[lua]', err);
          runtime.getAPI().showMessage(`lua error: ${String(err)}`);
        }
      });

      // Toggle tree-sitter highlighting for the current buffer
      vimInstance.getAPI().registerCommand('ts', async () => {
        const active = await runtime.evalLua('return vim.treesitter.highlighter.active[1] ~= nil');
        if (active) {
          await runtime.evalLua('vim.treesitter.stop(1)');
          runtime.getAPI().showMessage('treesitter highlight OFF');
        } else {
          const enabled = await runtime.evalLua('return pcall(vim.treesitter.start, 0)');
          runtime.getAPI().showMessage(enabled ? 'treesitter highlight ON' : 'no grammar for this filetype');
        }
      });

      setVimState(vimInstance.getState());
    } catch (err) {
      console.error('Failed to initialize TUI engine:', err);
    }
  });

  // Sync viewport size with gutters
  createEffect(() => {
    const state = vimState();
    const grid = gridDim();
    const totalGutterWidth = state.gutters.reduce((acc, g) => acc + g.width, 0);
    const targetWidth = Math.max(1, grid.width - totalGutterWidth);
    const targetHeight = Math.max(1, grid.height - 2);

    if (vimInstance && (state.viewportWidth !== targetWidth || state.viewportHeight !== targetHeight)) {
      vimInstance.setViewportWidth(targetWidth);
      vimInstance.setViewportHeight(targetHeight);
    }
  });

  const stableRoot: any = {
    type: 'Box', 
    props: { x: 0, y: 0, width: gridDim().width, height: gridDim().height, __root: true }, 
    children: [] 
  };

  // Start Solid rendering into our custom root object
  // @ts-ignore
  onCleanup(render(() => (
    <VimUI 
      buffer={() => vimState().buffer} 
      cursor={() => vimState().cursor} 
      visualStart={() => vimState().visualStart}
      topLine={() => vimState().topLine}
      leftCol={() => vimState().leftCol}
      mode={() => vimState().mode} 
      commandText={() => vimState().commandText}
      commandCursorX={() => vimState().commandCursorX}
      currentFilePath={() => vimState().currentFilePath}
      isExplorer={() => vimState().isExplorer}
      explorerPath={() => vimState().explorerPath}
      isReadOnly={() => vimState().isReadOnly}
      plugins={() => vimState().plugins}
      gutters={() => vimState().gutters}
      lineRenderers={() => vimState().lineRenderers}
      completionItems={() => vimState().completionItems}
      selectedCompletionIndex={() => vimState().selectedCompletionIndex}
      hoverText={() => vimState().hoverText}
      hoverPos={() => vimState().hoverPos}
      hoverScrollOffset={() => vimState().hoverScrollOffset}
      statusMessage={() => vimState().statusMessage}
      wrap={() => vimState().wrap}
      lineEnding={() => vimState().lineEnding}
      picker={() => vimState().picker}
      width={() => gridDim().width}
      height={() => gridDim().height}
      onCursorChange={(c) => setVisualCursor(c)}
    />
  ), stableRoot));

  const runTick = () => {
    try {
      // Sync dimensions to root
      stableRoot.props.width = gridDim().width;
      stableRoot.props.height = gridDim().height;

      const cleanTree = (node: any): any[] => {
        if (!node) return [];

        let type = '';
        let props: any = {};
        let rawChildren: any[] = [];

        if (node instanceof Element) {
          const tag = node.localName;
          type = tag === 'box' ? 'Box' : (tag === 'text' ? 'Text' : tag.charAt(0).toUpperCase() + tag.slice(1));
          for (let i = 0; i < node.attributes.length; i++) {
            const attr = node.attributes[i];
            let value: any = attr.value;
            let type = PROP_TO_TYPE_MAP.get(attr.name);
            if (type != undefined) {
              let parser = TYPE_PARSER_MAP.get(type);
              if (parser != undefined) {
                value = parser(value);
              }
            }
            props[attr.name] = value;
          }
          rawChildren = Array.from(node.childNodes);
        }
        else if (node instanceof Text) {
          type = 'Text';
          props = { content: node.textContent || '' };
        }
        else if (node.type && !node.nodeType) {
          type = node.type;
          props = { ...node.props };
          rawChildren = Array.isArray(node.children) ? node.children : [];
        }
        else if (typeof node === 'function') {
          try { return cleanTree(node()); } catch { return []; }
        }
        else {
          return [];
        }

        ['x', 'y', 'width', 'height'].forEach(p => {
          if (props[p] !== undefined) {
            const num = Number(props[p]);
            props[p] = isNaN(num) ? 0 : Math.max(0, Math.floor(num));
          }
        });

        props.border = props.border === true || props.border === 'true';
        props.clear_bg = props.clearBg !== undefined ? (props.clearBg === true || props.clearBg === 'true') : 
                          props.clear_bg !== undefined ? (props.clear_bg === true || props.clear_bg === 'true') : true;

        if (props.content !== undefined) props.content = String(props.content ?? '');
        if (props.title !== undefined) props.title = String(props.title ?? '');
        if (props.color !== undefined) props.color = String(props.color);
        if (props.bg_color !== undefined) props.bg_color = String(props.bg_color);
        if (props.bgColor !== undefined) props.bg_color = String(props.bgColor);

        return [{
          type,
          props,
          children: rawChildren.flatMap(cleanTree)
        }];
      };

      const sanitized = cleanTree(stableRoot);
      const sanitizedRoot = sanitized.length > 0 ? sanitized[0] : null;

      if (sanitizedRoot && rustEngine) {
        const output = rustEngine.render(sanitizedRoot);
        if (output) {
          setRenderData({
            chars: new Uint8Array(output.chars),
            fgs: new Uint8Array(output.fgs),
            bgs: new Uint8Array(output.bgs),
          });
        }
      }
    } catch (e) {
      console.error("Error in TUI tick:", e);
    }
  };

  // Coalesce renders to one per animation frame. Without this, rapid state
  // changes (e.g. touch-drag scroll issuing multiple ctrl+e) each run the full
  // TUI render synchronously, which stalls the main thread and causes the
  // browser to throttle/drop touchmove events mid-gesture.
  let tickRaf = 0;
  const scheduleTick = () => {
    if (tickRaf) return;
    tickRaf = requestAnimationFrame(() => {
      tickRaf = 0;
      runTick();
    });
  };

  // Watch for changes and request a tick
  createEffect(() => {
    vimState();
    gridDim();
    scheduleTick();
  });

  // Shared key handler
  const processKey = (key: string, ctrl: boolean = false) => {
    // Map common keys to Vim-friendly names
    const keyMap: Record<string, string> = {
      'ESC': 'Escape',
      'TAB': 'Tab',
      '↑': 'ArrowUp',
      '↓': 'ArrowDown',
      '←': 'ArrowLeft',
      '→': 'ArrowRight',
      'PGUP': 'PageUp',
      'PGDN': 'PageDown',
      'HOME': 'Home',
      'END': 'End',
      'backspace': 'Backspace',
      'enter': 'Enter'
    };
    const mappedKey = keyMap[key] || key;
    if (vimInstance) {
      vimInstance.handleKey(mappedKey, ctrl);
    }
  };
  (window as any).processKey = processKey;

  // Native/system virtual keyboard (hidden contenteditable technique,
  // similar to CodeMirror's mobile input handling).
  const dispatchSysKbData = (data: string) => {
    if (!data) return;
    for (const ch of data) {
      if (ch === '\n' || ch === '\r') {
        processKey('Enter');
      } else {
        processKey(ch);
      }
    }
  };

  const resetSysKbInput = () => {
    const el = sysKbInputRef;
    if (!el) return;
    el.textContent = '';
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch (e) {
      // no-op
    }
  };

  // CodeMirror treats the contenteditable DOM as the source of truth during a
  // composition: each browser mutation (append via autocomplete, mid-word
  // backspace, or a re-written word) is reflected here as an insert or delete.
  // Diff the current composition against the last one and mirror it into vim
  // so the buffer stays in sync even before the composition is committed.
  const syncSysKbComposition = (cur: string) => {
    const prev = sysKbLastComposed;
    if (cur === prev) return;

    // Longest common prefix: everything after it is either removed or added.
    let p = 0;
    const max = Math.min(prev.length, cur.length);
    while (p < max && prev[p] === cur[p]) p++;

    if (p < prev.length) {
      // Characters were dropped (mid-composition backspace / word rewrite).
      for (let i = p; i < prev.length; i++) processKey('Backspace');
    }
    if (p < cur.length) {
      dispatchSysKbData(cur.slice(p));
    }

    sysKbLastComposed = cur;
  };

  const handleSysKbBeforeInput = (e: InputEvent) => {
    // Composition is applied from the `input` event via the textContent diff
    // above, which is authoritative (e.data varies across platforms). Do NOT
    // preventDefault or clear the element here — the IME must stay alive.
    if (sysKbComposing) return;

    // The key was already dispatched from raw `keydown`; some platforms still
    // fire beforeinput afterwards (autocomplete/prediction), so swallow it.
    if (sysKbPendingKeyDown) {
      sysKbPendingKeyDown = false;
      return;
    }

    const inputType = e.inputType || '';
    if (inputType.startsWith('insertText') || inputType.startsWith('insertFromPaste') || inputType.startsWith('insertFromYank')) {
      e.preventDefault();
      dispatchSysKbData(e.data || '');
      resetSysKbInput();
    } else if (inputType === 'insertLineBreak' || inputType === 'insertParagraph' || inputType === 'insertNewline') {
      e.preventDefault();
      processKey('Enter');
      resetSysKbInput();
    } else if (inputType === 'deleteContentBackward') {
      e.preventDefault();
      processKey('Backspace');
      resetSysKbInput();
    } else if (inputType === 'deleteContentForward') {
      e.preventDefault();
      processKey('Delete');
      resetSysKbInput();
    }
  };

  const handleSysKbKeyDown = (e: KeyboardEvent) => {
    // During IME composition, let the input method drive input. Also skip
    // keys where Android only reports keyCode 229 (IME/autocomplete active).
    if (sysKbComposing || e.isComposing || e.keyCode === 229) return;

    const special = ['Escape', 'Tab', 'Enter', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];

    if (special.includes(e.key)) {
      sysKbPendingKeyDown = true;
      e.preventDefault();
      processKey(e.key);
      return;
    }

    // Printable characters: dispatch each keystroke immediately and cancel
    // the default so the OS keyboard's autocomplete/autocorrect cannot group
    // (or swallow) individual keystrokes — essential for vim's modes.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      sysKbPendingKeyDown = true;
      e.preventDefault();
      processKey(e.key);
    }
  };

  const handleSysKbCompositionStart = () => {
    sysKbComposing = true;
    sysKbLastComposed = '';
    sysKbPendingKeyDown = false;
  };

  const handleSysKbInput = () => {
    if (sysKbComposing) {
      // The browser has just mutated the composition; mirror that change into
      // vim (append or backspace) so mid-composition edits stay in sync.
      const el = sysKbInputRef;
      if (el) {
        syncSysKbComposition(el.textContent || '');
        sysKbPendingKeyDown = false;
      }
      return;
    }
    sysKbPendingKeyDown = false;
    resetSysKbInput();
  };

  const handleSysKbCompositionEnd = (e: CompositionEvent) => {
    sysKbComposing = false;
    // The letters (and any mid-composition backspaces) were already mirrored
    // incrementally via the `input` diff; only flush a tail we haven't seen
    // (e.g. a word committed straight to its final form).
    const finalText = e.data ?? sysKbInputRef?.textContent ?? '';
    if (finalText.length > sysKbLastComposed.length && finalText.startsWith(sysKbLastComposed)) {
      dispatchSysKbData(finalText.slice(sysKbLastComposed.length));
    }
    sysKbLastComposed = '';
    sysKbPendingKeyDown = false;
    resetSysKbInput();
  };

  const handleSysKbBlur = () => {
    if (!sysKbOpen()) return;
    // A tap on a nav button (or elsewhere) must not dismiss the native
    // keyboard — refocus so typing continues uninterrupted.
    requestAnimationFrame(() => {
      if (sysKbOpen()) {
        sysKbInputRef?.focus();
      }
    });
  };

  const positionSysKbInput = () => {
    const el = sysKbInputRef;
    const cRef = containerRef;
    if (!el || !cRef) return;
    const cell = charSize();
    const rect = cRef.getBoundingClientRect();
    const left = Math.max(0, Math.min(visualCursor().x * cell.width, rect.width - cell.width));
    const top = Math.max(0, Math.min(visualCursor().y * cell.height, rect.height - cell.height));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${Math.max(10, cell.width)}px`;
    el.style.height = `${Math.max(10, cell.height)}px`;
  };

  const openSysKb = () => {
    sysKbComposing = false;
    sysKbPendingKeyDown = false;
    sysKbLastComposed = '';
    setSysKbOpen(true);
    if (showKeyboard()) {
      // Close the custom keyboard and replace its history entry (it is on
      // top), so one back press cleanly closes the system keyboard.
      setShowKeyboard(false);
      window.history.replaceState({ sysKb: true }, '');
    } else {
      window.history.pushState({ sysKb: true }, '');
    }
    requestAnimationFrame(() => {
      positionSysKbInput();
      sysKbInputRef?.focus();
    });
  };

  const closeSysKb = () => {
    setSysKbOpen(false);
    sysKbInputRef?.blur();
    if (window.history.state?.sysKb) {
      window.history.back();
    }
  };

  // Keep the hidden input positioned on the vim caret while it's open.
  createEffect(() => {
    void sysKbOpen();
    void visualCursor();
    void charSize();
    positionSysKbInput();
  });

  // Keyboard listeners for Desktop
  const handleKeyDown = (e: KeyboardEvent) => {
    if (isMobile()) return;
    
    const controlKeys = [
      'Escape', 'Backspace', 'Enter', 'Tab',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'Home', 'End', 'PageUp', 'PageDown',
      'Insert', 'Delete',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
    ];

    if (controlKeys.includes(e.key) || e.ctrlKey || e.altKey || e.metaKey) {
      if (e.key === 'F12' || (e.ctrlKey && (e.key === 'r' || e.key === 'R' || e.key === 'i' || e.key === 'I'))) {
        return;
      }
      e.preventDefault();
      processKey(e.key, e.ctrlKey);
    }
  };

  // Window-level keydown listener with capture to intercept Ctrl+Space before browser/OS
  const handleWindowKeyDown = (e: KeyboardEvent) => {
    if (isMobile()) return;
    if (e.ctrlKey && (e.key === ' ' || e.keyCode === 32)) {
      e.preventDefault();
      e.stopPropagation();
      processKey(' ', true);
    }
  };

  const handleKeyPress = (e: KeyboardEvent) => {
    if (isMobile()) return;
    e.preventDefault();
    processKey(e.key, e.ctrlKey);
  };

  const handleWheel = (e: WheelEvent) => {
    if (vimInstance) {
      if (e.ctrlKey) {
        // Zooming
        e.preventDefault();
        const delta = -e.deltaY;
        const factor = delta > 0 ? 1.1 : 0.9;
        
        const currentSize = charSize();
        const aspectRatio = currentSize.height / currentSize.width;
        const newWidth = Math.max(5, Math.min(50, currentSize.width * factor));
        const newHeight = newWidth * aspectRatio;
        
        setCharSize({ width: newWidth, height: newHeight });
        updateDimensions();
        return;
      }

      // Normal mode scrolling with wheel
      if (e.deltaY > 0) {
        processKey('e', true); // Scroll down (Ctrl+e)
      } else if (e.deltaY < 0) {
        processKey('y', true); // Scroll up (Ctrl+y)
      }
      e.preventDefault();
    }
  };


  // Handle Android back button to close keyboard
  const handlePopState = (e: PopStateEvent) => {
    if (sysKbOpen()) {
      setSysKbOpen(false);
    } else if (showKeyboard()) {
      setShowKeyboard(false);
    }
  };

  // Pinch-to-zoom event handlers
  let lastTouchTime = 0;
  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
      initialCharSize = charSize();
    } else if (e.touches.length === 1) {
      lastTouchY = e.touches[0].clientY;
      touchScrollAccumulator = 0;
    }
    
    // Prevent double-tap zoom
    const now = Date.now();
    if (now - lastTouchTime < 300) {
      e.preventDefault();
    }
    lastTouchTime = now;
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && initialPinchDistance > 0) {
      e.preventDefault(); // Prevent browser zoom
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDistance = Math.sqrt(dx * dx + dy * dy);
      const scale = currentDistance / initialPinchDistance;
      
      // Update char size based on scale
      const aspectRatio = initialCharSize.height / initialCharSize.width;
      const newWidth = Math.max(5, Math.min(50, initialCharSize.width * scale));
      const newHeight = newWidth * aspectRatio;
      setCharSize({ width: newWidth, height: newHeight });
      updateDimensions();
    } else if (e.touches.length === 1 && vimInstance) {
      const currentY = e.touches[0].clientY;
      const deltaY = lastTouchY - currentY;
      lastTouchY = currentY;
      touchScrollAccumulator += deltaY;

      const rowHeight = charSize().height;
      if (Math.abs(touchScrollAccumulator) >= rowHeight) {
        const rowsToScroll = Math.floor(Math.abs(touchScrollAccumulator) / rowHeight);
        batch(() => {
          for (let i = 0; i < rowsToScroll; i++) {
            if (touchScrollAccumulator > 0) {
              processKey('e', true); // Scroll down (Ctrl+e)
            } else {
              processKey('y', true); // Scroll up (Ctrl+y)
            }
          }
        });
        touchScrollAccumulator %= rowHeight;
      }
      e.preventDefault();
    }
  };

  const handleTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) {
      initialPinchDistance = 0;
    }
    if (e.touches.length === 0) {
      touchScrollAccumulator = 0;
    }
  };

  const handleTouchCancel = () => {
    // The browser interrupted the gesture (system UI, gesture takeover, etc.).
    // Reset drag state so a subsequent touch starts clean instead of resuming
    // with a stale lastTouchY/accumulator that immediately over-scrolls.
    initialPinchDistance = 0;
    lastTouchY = 0;
    touchScrollAccumulator = 0;
  };

  onMount(() => {
    if (containerRef == undefined) {
      return;
    }

    // Track visualViewport for Capacitor keyboard handling
    const updateViewportHeight = () => {
      if (window.visualViewport) {
        const viewport = window.visualViewport;
        // Use CSS custom property to set dynamic height for Capacitor
        document.documentElement.style.setProperty('--vim-editor-height', `${viewport.height}px`);
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportHeight);
      window.visualViewport.addEventListener('scroll', updateViewportHeight);
    }

    containerRef.addEventListener('keydown', handleKeyDown);
    containerRef.addEventListener('keypress', handleKeyPress);
    containerRef.addEventListener('wheel', handleWheel, { passive: false });
    containerRef.addEventListener('resize', updateDimensions);
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('keydown', handleWindowKeyDown, true); // Capture mode for Ctrl+Space
    containerRef.addEventListener('touchstart', handleTouchStart, { passive: false });
    containerRef.addEventListener('touchmove', handleTouchMove, { passive: false });
    containerRef.addEventListener('touchend', handleTouchEnd);
    containerRef.addEventListener('touchcancel', handleTouchCancel, { passive: false });
    let resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });
    resizeObserver.observe(containerRef);
    onCleanup(() => {
      if (tickRaf) {
        cancelAnimationFrame(tickRaf);
        tickRaf = 0;
      }
      resizeObserver.unobserve(containerRef);
      resizeObserver.disconnect();
      containerRef.removeEventListener('keydown', handleKeyDown);
      containerRef.removeEventListener('keypress', handleKeyPress);
      containerRef.removeEventListener('wheel', handleWheel);
      containerRef.removeEventListener('resize', updateDimensions);
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('keydown', handleWindowKeyDown, true);
      containerRef.removeEventListener('touchstart', handleTouchStart);
      containerRef.removeEventListener('touchmove', handleTouchMove);
      containerRef.removeEventListener('touchend', handleTouchEnd);
      containerRef.removeEventListener('touchcancel', handleTouchCancel);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updateViewportHeight);
        window.visualViewport.removeEventListener('scroll', updateViewportHeight);
      }
      delete (window as any).processKey;
    });
  });

  let lastPointerDownTime = 0;

  const handlePointerDown = (e: PointerEvent) => {
    lastPointerDownTime = Date.now();
    // Close context menu if open
    if (contextMenu()) {
      setContextMenu(null);
      return;
    }

    if (!containerRef || !vimInstance) return;
    
    const rect = containerRef.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const grid = gridDim();
    if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
      const col = Math.floor((x / rect.width) * grid.width);
      const row = Math.floor((y / rect.height) * grid.height);

      // Only jump if clicking in the buffer area (above status and command lines)
      if (row < grid.height - 2) {
        const state = vimState();
        const totalGutterWidth = state.gutters.reduce((acc, g) => acc + g.width, 0);
        const vWidth = Math.max(1, grid.width - totalGutterWidth);
        const clickCol = col - totalGutterWidth;

        if (state.wrap) {
          let currentY = 0;
          const lines = state.buffer;
          const start = state.topLine;

          for (let i = start; i < lines.length; i++) {
            const line = lines[i];
            const lineRows = Math.max(1, Math.ceil((line?.length || 0) / vWidth));

            if (currentY + lineRows > row) {
              // Clicked on this buffer line
              const rowInLine = row - currentY;
              const finalCol = rowInLine * vWidth + clickCol;
              vimInstance.setCursor(Math.max(0, Math.min(finalCol, line?.length || 0)), i);
              return;
            }
            currentY += lineRows;
            if (currentY >= grid.height - 2) break;
          }
        } else {
          vimInstance.setCursor(Math.max(0, clickCol + state.leftCol), row + state.topLine);
        }
      }
    }
    };
  const handlePointerUp = (e: PointerEvent) => {
    const duration = Date.now() - lastPointerDownTime;
    if (isMobile() && duration < 300) {
      // Native/system keyboard takes precedence: keep it focused.
      if (sysKbOpen()) {
        sysKbInputRef?.focus();
        return;
      }
      if (!showKeyboard()) {
        setShowKeyboard(true);
        window.history.pushState({ keyboard: true }, '');
      }
    }
  };

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    
    // Check if the interaction is over the editor canvas (containerRef)
    if (!containerRef || !containerRef.contains(e.target as Node)) {
      return;
    }

    const state = vimState();
    if (state.contextMenuItems && state.contextMenuItems.length > 0) {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: state.contextMenuItems
      });
    }
  };

  return (
    <div 
      style={{ 
        width: '100%', 
        height: 'var(--vim-editor-height, 100%)',
        position: 'relative',
        background: '#050505', 
        display: 'flex', 
        'flex-direction': 'column',
        'justify-content': 'center', 
        'align-items': 'center',
        overflow: 'hidden'
      }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
    >
      <div 
        ref={containerRef}
        style={{ 
          width: '100%', 
          flex: 1,
          position: 'relative', 
          background: 'black',
          display: 'flex',
          'flex-direction': 'column',
          overflow: 'hidden',
        }}
        tabIndex={-1}
        onFocusIn={() => setHasFocus(true)}
        onFocusOut={() => setHasFocus(false)}
      >
        <Show when={rendererMode() === 'webgl'} fallback={
          <DOMRenderer
            chars={renderData().chars}
            fgs={renderData().fgs}
            bgs={renderData().bgs}
            width={gridDim().width}
            height={gridDim().height}
            cellWidth={charSize().width}
            cellHeight={charSize().height}
            showCursor={hasFocus()}
            cursorX={visualCursor().x}
            cursorY={visualCursor().y}
            crtEnabled={crtEnabled()}
            showKeyboard={showKeyboard()}
            onMeasure={(size) => {
              console.log('Measured font size (dom):', size);
              setCharSize(size);
              updateDimensions();
            }}
          />
        }>
          <WebGLRenderer
            chars={renderData().chars}
            fgs={renderData().fgs}
            bgs={renderData().bgs}
            width={gridDim().width}
            height={gridDim().height}
            showCursor={hasFocus()}
            cursorX={visualCursor().x}
            cursorY={visualCursor().y}
            crtEnabled={crtEnabled()}
            showKeyboard={showKeyboard()}
            onMeasure={(size) => {
              console.log('Measured font size:', size);
              setCharSize(size);
              updateDimensions();
            }}
          />
        </Show>

        {/* Hidden contenteditable that summons the native/system keyboard */}
        <Show when={sysKbOpen()}>
          <div
            ref={sysKbInputRef}
            contenteditable="true"
            inputmode="text"
            autocapitalize="none"
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            enterkeyhint="enter"
            aria-hidden="true"
            onBeforeInput={handleSysKbBeforeInput}
            onInput={handleSysKbInput}
            onKeyDown={handleSysKbKeyDown}
            onBlur={handleSysKbBlur}
            onCompositionStart={handleSysKbCompositionStart}
            onCompositionEnd={handleSysKbCompositionEnd}
            style={{
              position: 'absolute',
              left: '0px',
              top: '0px',
              width: '10px',
              height: '10px',
              opacity: '0',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              'caret-color': 'transparent',
              color: 'transparent',
              overflow: 'hidden',
              'white-space': 'pre',
              'font-size': '1px',
              'pointer-events': 'none',
              'z-index': 99,
              '-webkit-user-modify': 'read-write-plaintext-only',
            }}
          />
        </Show>
      </div>

      <div style={{ width: '100%', 'margin-top': '0px', overflow: 'hidden' }}>
        <Show when={isMobile()}>
          <Show when={showKeyboard() && !sysKbOpen()}>
            <div style={{ width: '100%', display: 'flex', 'justify-content': 'center' }}>
              <VirtualKeyboard 
                onKeyPress={(key, mods) => (window as any).processKey?.(key, mods.ctrl)} 
                onCollapse={() => {
                  setShowKeyboard(false);
                  if (window.history.state?.keyboard) {
                    window.history.back();
                  }
                }}
              />
            </div>
          </Show>
          <Show when={sysKbOpen()}>
            <div style={{ width: '100%', display: 'flex', 'justify-content': 'center' }}>
              <VirtualKeyboard 
                navOnly
                onKeyPress={(key, mods) => (window as any).processKey?.(key, mods.ctrl)} 
                onCollapse={() => closeSysKb()}
              />
            </div>
          </Show>
        </Show>
      </div>

      {/* Context Menu Overlay */}
      <Show when={contextMenu()}>
        <div 
          style={{
            position: 'fixed',
            top: `${contextMenu()?.y}px`,
            left: `${contextMenu()?.x}px`,
            background: '#252526',
            border: '1px solid #454545',
            'box-shadow': '0 2px 10px rgba(0,0,0,0.5)',
            'z-index': 1000,
            padding: '4px 0',
            'min-width': '150px'
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <For each={contextMenu()?.items}>
            {(item) => (
              <div 
                style={{
                  padding: '6px 12px',
                  cursor: 'pointer',
                  color: '#cccccc',
                  'font-size': '14px',
                  'font-family': 'sans-serif'
                }}
                onMouseOver={(e) => (e.currentTarget.style.background = '#094771')}
                onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => {
                  item.action();
                  setContextMenu(null);
                }}
              >
                {item.label}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

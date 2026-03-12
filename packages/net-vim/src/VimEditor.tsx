import { createSignal, onMount, Show, createEffect, For } from 'solid-js';
import { render } from './solid-universal-tui';
import { WebGLRenderer } from './WebGLRenderer';
import { VimEngine } from './vim-engine';
import { VimUI } from './VimUI';
import type { VimState } from './types';
import { getConfigFile, ensureConfigDir, writeConfigFile, PRELUDE_BASE } from './opfs-util';
import { VirtualKeyboard } from '@net-vim/virtual-keyboard';
// @ts-ignore
import init, { Engine } from './wasm/tui_engine';

const CONFIG_PATH = '.config/net-vim/init.ts';

const DEFAULT_INIT = `
export default {
  metadata: {
    name: "user-init",
    description: "User startup configuration"
  },
  setup: async (api) => {
    api.log("Custom init.ts loaded from OPFS!");
    
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

// Sample TypeScript Plugin Source
const helloPlugin = `
export default {
  metadata: {
    name: "hello-plugin",
    description: "A simple plugin that greets you and tracks mode changes."
  },
  setup: (api) => {
    api.log("Hello from the Babel-transpiled plugin!");
    
    // Register a custom command
    api.registerCommand("hello", (args) => {
      api.log("Command :hello executed with args:", args);
      // In a real TUI we'd probably show a message in the UI instead of alert
      console.log("HELLO FROM PLUGIN!", args);
    });

    // Listen for mode changes
    api.on("ModeChanged", (data) => {
      api.log("Mode changed from " + data.from + " to " + data.to);
      const count = api.storage.get("modeChanges") || 0;
      api.storage.set("modeChanges", count + 1);
      api.log("Total mode changes: " + (count + 1));
    });
  }
};
`;

export default function VimEditor(props: { engine?: VimEngine, ref?: (engine: VimEngine) => void }) {
  const [gridDim, setGridDim] = createSignal({ width: 80, height: 24 });
  const [isMobile, setIsMobile] = createSignal(false);
  const [showKeyboard, setShowKeyboard] = createSignal(false);
  const [crtEnabled, setCrtEnabled] = createSignal(false);
  const [contextMenu, setContextMenu] = createSignal<{ x: number, y: number, items: any[] } | null>(null);
  
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
    statusMessage: null,
  });

  let containerRef: HTMLDivElement | undefined;
  let rustEngine: Engine | null = null;
  let vimInstance: VimEngine | null = props.engine || null;

  // Variables for touch interaction (pinch-to-zoom and scrolling)
  let initialPinchDistance = 0;
  let initialCharSize = { width: 10, height: 20 };
  let lastTouchY = 0;
  let touchScrollAccumulator = 0;

  const lineNumbersPlugin = `
export default {
  metadata: {
    name: "line-numbers",
    description: "Provides line numbers in the gutter"
  },
  setup: (api) => {
    api.log("Setting up line-numbers plugin...");
    api.registerGutter({
      name: "line-numbers",
      width: 4,
      priority: 100,
      render: ({ lineIndex, isCursorLine }) => {
        const getVal = (val) => (typeof val === "function" ? val() : val);
        const num = () => (getVal(lineIndex) + 1).toString().padStart(3, " ");
        return (
          <text 
            content={() => num() + " "} 
            color={() => getVal(isCursorLine) ? "#ffffff" : "#888888"} 
          />
        );
      }
    });
    api.log("Line-numbers gutter registered");
  }
};
`;

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

      if (props.engine) {
        vimInstance = props.engine;
        vimInstance.setUpdateCallback(onUpdate);
      } else {
        vimInstance = new VimEngine(onUpdate);
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

      // Visual Viewport tracking for mobile keyboard
      const updateViewport = () => {
        updateDimensions();
      };

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateViewport);
        window.visualViewport.addEventListener('scroll', updateViewport);
        updateViewport();
      }

      // Update dimensions when virtual keyboard visibility changes
      createEffect(() => {
        showKeyboard();
        updateDimensions();
      });
      
      // Initialize Plugins
      
      // 1. Check OPFS for init.ts
      try {
        let initSource = await getConfigFile(CONFIG_PATH);
        if (initSource) {
           await vimInstance.loadPluginFromSource("init.ts", initSource);
        } else {
           console.log("No init.ts found at", CONFIG_PATH);
        }
      } catch (e) {
        console.error("Error loading init.ts from OPFS:", e);
      }
      
      // Register CRT toggle command
      vimInstance.getAPI().registerCommand('crt', () => {
        setCrtEnabled(!crtEnabled());
      });

      // Command to create a default init.ts if missing
      vimInstance.getAPI().registerCommand('create-init', async () => {
        await writeConfigFile(CONFIG_PATH, DEFAULT_INIT);
        console.log("Created default init.ts in OPFS at", CONFIG_PATH);
      });


      setVimState(vimInstance.getState());

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

      const handleKeyPress = (e: KeyboardEvent) => {
        if (isMobile()) return;
        e.preventDefault();
        processKey(e.key, e.ctrlKey);
      };

      const handleWheel = (e: WheelEvent) => {
        if (vimInstance) {
          // Normal mode scrolling with wheel
          if (e.deltaY > 0) {
            processKey('e', true); // Scroll down (Ctrl+e)
          } else if (e.deltaY < 0) {
            processKey('y', true); // Scroll up (Ctrl+y)
          }
          e.preventDefault();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keypress', handleKeyPress);
      window.addEventListener('wheel', handleWheel, { passive: false });
      window.addEventListener('resize', updateDimensions);

      // Handle Android back button to close keyboard
      const handlePopState = (e: PopStateEvent) => {
        if (showKeyboard()) {
          setShowKeyboard(false);
        }
      };
      window.addEventListener('popstate', handlePopState);

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
            for (let i = 0; i < rowsToScroll; i++) {
              if (touchScrollAccumulator > 0) {
                processKey('e', true); // Scroll down (Ctrl+e)
              } else {
                processKey('y', true); // Scroll up (Ctrl+y)
              }
            }
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

      window.addEventListener('touchstart', handleTouchStart, { passive: false });
      window.addEventListener('touchmove', handleTouchMove, { passive: false });
      window.addEventListener('touchend', handleTouchEnd);

      const stableRoot: any = { 
        type: 'Box', 
        props: { x: 0, y: 0, width: gridDim().width, height: gridDim().height, __root: true }, 
        children: [] 
      };

      // Start Solid rendering into our custom root object
      // @ts-ignore
      render(() => (
        <VimUI 
          buffer={() => vimState().buffer} 
          cursor={() => vimState().cursor} 
          visualStart={() => vimState().visualStart}
          topLine={() => vimState().topLine}
          leftCol={() => vimState().leftCol}
          mode={() => vimState().mode} 
          commandText={() => vimState().commandText}
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
          statusMessage={() => vimState().statusMessage}
          wrap={() => vimState().wrap}
          width={() => gridDim().width}
          height={() => gridDim().height}
          onCursorChange={(c) => setVisualCursor(c)}
        />
      ), stableRoot);

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

      // Watch for changes and request a tick
      createEffect(() => {
        vimState();
        gridDim();
        runTick();
      });

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keypress', handleKeyPress);
        window.removeEventListener('wheel', handleWheel);
        window.removeEventListener('resize', updateDimensions);
        window.removeEventListener('popstate', handlePopState);
        window.removeEventListener('touchstart', handleTouchStart);
        window.removeEventListener('touchmove', handleTouchMove);
        window.removeEventListener('touchend', handleTouchEnd);
        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', updateViewport);
          window.visualViewport.removeEventListener('scroll', updateViewport);
        }
        delete (window as any).processKey;
      };
    } catch (err) {
      console.error('Failed to initialize TUI engine:', err);
    }
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
        const totalGutterWidth = vimState().gutters.reduce((acc, g) => acc + g.width, 0);
        vimInstance.setCursor(col - totalGutterWidth + vimState().leftCol, row + vimState().topLine);
      }
    }
  };

  const handlePointerUp = (e: PointerEvent) => {
    const duration = Date.now() - lastPointerDownTime;
    if (isMobile() && duration < 300) {
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
        height: '100%', 
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
          overflow: 'hidden'
        }}
      >
        <WebGLRenderer
          chars={renderData().chars}
          fgs={renderData().fgs}
          bgs={renderData().bgs}
          width={gridDim().width}
          height={gridDim().height}
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
      </div>

      <div style={{ width: '100%', 'margin-top': '0px', overflow: 'hidden' }}>
        <Show when={isMobile()}>
          <Show when={showKeyboard()}>
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

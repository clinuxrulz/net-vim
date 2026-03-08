import { createSignal, onMount, Show, createEffect } from 'solid-js';
import { render } from './solid-universal-tui';
import { WebGLRenderer } from './WebGLRenderer';
import { VimEngine } from './vim-engine';
import { VimUI } from './VimUI';
import { getConfigFile, ensureConfigDir, writeConfigFile } from './opfs-util';
import { VirtualKeyboard } from 'virtual-keyboard';
// @ts-ignore
import init, { Engine } from '../crates/tui-engine/pkg/tui_engine';

const CONFIG_PATH = '.config/web-vim/init.ts';

const DEFAULT_INIT = `
export default {
  metadata: {
    name: "user-init",
    description: "User startup configuration"
  },
  setup: async (api) => {
    api.log("Custom init.ts loaded from OPFS!");
    
    // Load built-in plugins from the virtual prelude if desired:
    const lineNumbers = await api.fs.readFile(".config/web-vim/prelude/line-numbers.tsx");
    if (lineNumbers) {
      await api.loadPluginFromSource("line-numbers", lineNumbers);
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

export default function App() {
  const [gridDim, setGridDim] = createSignal({ width: 80, height: 24 });
  const [isMobile, setIsMobile] = createSignal(false);
  const [showKeyboard, setShowKeyboard] = createSignal(false);
  const [crtEnabled, setCrtEnabled] = createSignal(false);
  
  const [visualCursor, setVisualCursor] = createSignal({ x: 0, y: 0 });

  const [renderData, setRenderData] = createSignal({
    chars: new Uint8Array(80 * 24),
    fgs: new Uint8Array(80 * 24 * 3),
    bgs: new Uint8Array(80 * 24 * 3),
  });

  const [vimState, setVimState] = createSignal({
    buffer: [] as string[],
    cursor: { x: 0, y: 0 },
    topLine: 0,
    leftCol: 0,
    mode: 'Normal' as any,
    commandText: '',
    currentFilePath: null as string | null,
    isExplorer: false,
    explorerPath: '',
    isReadOnly: false,
    plugins: [] as any[],
    gutters: [] as any[],
  });

  const [viewportHeight, setViewportHeight] = createSignal(window.innerHeight);
  const [viewportTop, setViewportTop] = createSignal(0);

  let hiddenInputRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let rustEngine: Engine | null = null;
  let vimInstance: VimEngine | null = null;

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
      
      const vim = new VimEngine(() => {
        setVimState(vim.getState());
      });
      vimInstance = vim;
      
      // Initialize Engine after WASM init
      rustEngine = new Engine(gridDim().width, gridDim().height);

      // Initial sizing
      updateDimensions();
      const initialGutterWidth = vim.getState().gutters.reduce((acc: number, g: any) => acc + g.width, 0);
      vim.setViewportHeight(gridDim().height - 2);
      vim.setViewportWidth(gridDim().width - initialGutterWidth);

      // Visual Viewport tracking for mobile keyboard
      const updateViewport = () => {
        if (window.visualViewport) {
          setViewportHeight(window.visualViewport.height);
          setViewportTop(window.visualViewport.offsetTop);
          updateDimensions();
        }
      };

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateViewport);
        window.visualViewport.addEventListener('scroll', updateViewport);
        updateViewport();
      }
      
      // Initialize Plugins
      
      // 1. Check OPFS for init.ts
      try {
        let initSource = await getConfigFile(CONFIG_PATH);
        if (initSource) {
           await vim.loadPluginFromSource("init.ts", initSource);
        } else {
           console.log("No init.ts found at", CONFIG_PATH);
        }
      } catch (e) {
        console.error("Error loading init.ts from OPFS:", e);
      }
      
      // Register CRT toggle command
      vim.getAPI().registerCommand('crt', () => {
        setCrtEnabled(!crtEnabled());
      });

      // Command to create a default init.ts if missing
      vim.getAPI().registerCommand('create-init', async () => {
        await writeConfigFile(CONFIG_PATH, DEFAULT_INIT);
        console.log("Created default init.ts in OPFS at", CONFIG_PATH);
      });


      setVimState(vim.getState());

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
        vim.handleKey(mappedKey, ctrl);
      };
      (window as any).processKey = processKey;

      // Keyboard listener
      const handleKeyDown = (e: KeyboardEvent) => {
        const keysToPrevent = ['j', 'k', 'h', 'l', 'i', 'a', 'o', ':', '/', 'Escape', 'Backspace', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Home', 'End', 'PageUp', 'PageDown'];
        if (e.key.length === 1 || keysToPrevent.includes(e.key)) {
          if (keysToPrevent.includes(e.key) || e.ctrlKey) {
            e.preventDefault();
            processKey(e.key, e.ctrlKey);
          }
        }
      };
      
      const handleInput = (e: InputEvent) => {
        if (isMobile()) return; // Don't process input from hidden div on mobile

        console.log('InputEvent:', {
          data: e.data,
          inputType: e.inputType,
          textContentBeforeClear: hiddenInputRef?.textContent,
        });
        if (e.data && (e.inputType === 'insertText' || e.inputType === 'insertCompositionText')) {
          if (hiddenInputRef) hiddenInputRef.textContent = '';
          for (const char of e.data) {
            processKey(char);
          }
        }
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

      if (hiddenInputRef) {
        hiddenInputRef.addEventListener('input', handleInput as any);
      }

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
        window.removeEventListener('wheel', handleWheel);
        window.removeEventListener('resize', updateDimensions);
        window.removeEventListener('popstate', handlePopState);
        window.removeEventListener('touchstart', handleTouchStart);
        window.removeEventListener('touchmove', handleTouchMove);
        window.removeEventListener('touchend', handleTouchEnd);
        if (hiddenInputRef) {
          hiddenInputRef.removeEventListener('input', handleInput as any);
        }
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

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault();
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

    if (isMobile()) {
      if (!showKeyboard()) {
        setShowKeyboard(true);
        window.history.pushState({ keyboard: true }, '');
      }
    } else if (hiddenInputRef) {
      hiddenInputRef.focus();
    }
  };

  return (
    <div 
      style={{ 
        width: '100vw', 
        height: `${viewportHeight()}px`, 
        position: 'fixed',
        top: `${viewportTop()}px`,
        left: 0,
        background: '#050505', 
        display: 'flex', 
        'flex-direction': 'column',
        'justify-content': 'center', 
        'align-items': 'center',
        overflow: 'hidden'
      }}
      onPointerDown={handlePointerDown}
    >
      <Show when={!isMobile()}>
        <div
          ref={hiddenInputRef!}
          contenteditable="true"
          style={{
            position: 'absolute',
            opacity: 0,
            top: 0,
            left: 0,
            width: '1px',
            height: '1px',
            padding: 0,
            border: 'none',
            outline: 'none'
          }}
          // @ts-ignore
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
        ></div>
      </Show>

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
    </div>
  );
}

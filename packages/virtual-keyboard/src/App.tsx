import { For, type Component, createSignal } from 'solid-js';

export type KeyboardMode = 'alpha' | 'sym1' | 'sym2';

export interface VirtualKeyboardProps {
  onKeyPress?: (key: string, mods: { ctrl: boolean; alt: boolean; shift: boolean }) => void;
  onCollapse?: () => void;
}

const VirtualKeyboard: Component<VirtualKeyboardProps> = (props) => {
  const [mode, setMode] = createSignal<KeyboardMode>('alpha');
  const [isShift, setIsShift] = createSignal(false);
  const [isCtrl, setIsCtrl] = createSignal(false);
  const [isAlt, setIsAlt] = createSignal(false);

  let repeatTimeout: any = null;
  let repeatInterval: any = null;

  const stopRepeat = () => {
    if (repeatTimeout) {
      clearTimeout(repeatTimeout);
      repeatTimeout = null;
    }
    if (repeatInterval) {
      clearInterval(repeatInterval);
      repeatInterval = null;
    }
  };

  const startRepeat = (key: string) => {
    stopRepeat();
    // Only repeat certain keys. Explicitly excluding h, j, k, l.
    const repeatableKeys = ['↑', '↓', '←', '→', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'backspace', 'HOME', 'END', 'PGUP', 'PGDN'];
    if (!repeatableKeys.includes(key)) return;

    repeatTimeout = setTimeout(() => {
      repeatInterval = setInterval(() => {
        handleKeyPress(key, true);
      }, 50);
    }, 500);
  };

  const extraRows = [
    ['ESC', '/', '-', 'HOME', '↑', 'END', 'PGUP'],
    ['TAB', 'CTRL', 'ALT', '←', '↓', '→', 'PGDN'],
  ];

  const layouts = {
    alpha: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
      ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
      ['!#1', ',', 'English (AU)', '.', 'enter'],
    ],
    sym1: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['@', '#', '$', '%', '&', '-', '+', '(', ')'],
      ['*', '"', "'", ':', ';', '!', '?'],
      ['1/2', '_', '/', '\\', '|', '~', '<', '>', 'backspace'],
      ['ABC', ',', 'Space', '.', 'enter'],
    ],
    sym2: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['`', '•', '√', 'π', '÷', '×', '¶', '∆', '£', '¥'],
      ['€', '¢', '^', '°', '=', '{', '}', '[', ']'],
      ['2/2', '©', '®', '™', '℅', '§', '...', 'backspace'],
      ['ABC', ',', 'Space', '.', 'enter'],
    ]
  };

  const ShiftIcon = (p: { active: boolean }) => (
    <svg viewBox="0 0 24 24" style={{
      width: '24px', height: '24px', fill: p.active ? 'currentColor' : 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'box-sizing': 'border-box'
    }}>
      <path d="M12 4L4 12H8V20H16V12H20L12 4Z" />
    </svg>
  );

  const BackspaceIcon = () => (
    <svg viewBox="0 0 24 24" style={{
      width: '24px', height: '24px', fill: 'currentColor',
      stroke: 'none', 'box-sizing': 'border-box'
    }}>
      <path d="M21 4H8L1 12L8 20H21C22.1 20 23 19.1 23 18V6C23 4.9 22.1 4 21 4Z" />
      <path d="M18 8L12 14M12 8L18 14" stroke="black" stroke-width="2" stroke-linecap="round" />
    </svg>
  );

  const EnterIcon = () => (
    <svg viewBox="0 0 24 24" style={{
      width: '24px', height: '24px', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'box-sizing': 'border-box'
    }}>
      <path d="M19 8V12C19 14.2091 17.2091 16 15 16H5M5 16L9 12M5 16L9 20" />
    </svg>
  );

  const TabIcon = () => (
    <svg viewBox="0 0 24 24" style={{
      width: '24px', height: '24px', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'box-sizing': 'border-box'
    }}>
      <path d="M21 12H3M21 12L17 8M21 12L17 16M3 7V17" />
    </svg>
  );

  const CollapseIcon = () => (
    <svg viewBox="0 0 24 24" style={{
      width: '20px', height: '20px', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'box-sizing': 'border-box'
    }}>
      <path d="M7 10l5 5 5-5" />
    </svg>
  );

  const handleKeyPress = (key: string, isRepeat: boolean = false) => {
    if (key === 'shift') {
      setIsShift(!isShift());
      return;
    } else if (key === '!#1' || key === '1/2' || key === '2/2') {
      if (key === '!#1') setMode('sym1');
      if (key === '1/2') setMode('sym2');
      if (key === '2/2') setMode('sym1');
      return;
    } else if (key === 'ABC') {
      setMode('alpha');
      return;
    } else if (key === 'CTRL') {
      setIsCtrl(!isCtrl());
      return;
    } else if (key === 'ALT') {
      setIsAlt(!isAlt());
      return;
    }

    let char = key;
    const shift = isShift();
    const ctrl = isCtrl();
    const alt = isAlt();

    if (mode() === 'alpha' && shift && key.length === 1) {
      char = char.toUpperCase();
      if (!isRepeat) setIsShift(false);
    }

    if (char === 'English (AU)' || char === 'Space') char = ' ';
    
    props.onKeyPress?.(char, { ctrl, alt, shift });

    if (!isRepeat) {
      if (ctrl) setIsCtrl(false);
      if (alt) setIsAlt(false);
    }
  };

  const renderExtraKey = (key: string) => {
    let content: any = key;
    let isActive = false;

    if (key === 'TAB') content = <TabIcon />;
    if (key === 'CTRL') isActive = isCtrl();
    if (key === 'ALT') isActive = isAlt();

    return (
      <button 
        onPointerDown={(e) => { e.preventDefault(); handleKeyPress(key); startRepeat(key); }}
        onPointerUp={() => stopRepeat()}
        onPointerLeave={() => stopRepeat()}
        style={{
          background: isActive ? '#444' : '#000',
          color: '#fff',
          border: 'none',
          flex: '1',
          display: 'flex',
          'justify-content': 'center',
          'align-items': 'center',
          'font-size': '0.85rem',
          'font-weight': '500',
          cursor: 'pointer',
          height: '28px',
          'user-select': 'none',
          'box-sizing': 'border-box',
          padding: '0',
          margin: '0'
        }}
      >
        {content}
      </button>
    );
  };

  const renderKey = (key: string) => {
    let content: any = key;
    let style: any = {
      background: '#2c2c2c',
      color: '#fff',
      border: 'none',
      'border-radius': '6px',
      height: '38px',
      display: 'flex',
      'justify-content': 'center',
      'align-items': 'center',
      'font-size': '1.1rem',
      'font-weight': '400',
      cursor: 'pointer',
      flex: '1 1 0',
      'min-width': '0',
      'box-shadow': '0 1px 2px rgba(0, 0, 0, 0.3)',
      'user-select': 'none',
      'box-sizing': 'border-box',
      padding: '0',
      margin: '0'
    };

    if (key === 'shift') {
      style.flex = '1.4';
      style.background = isShift() ? '#fff' : '#3b3b3b';
      style.color = isShift() ? '#000' : '#fff';
      content = <ShiftIcon active={isShift()} />;
    } else if (key === 'backspace') {
      style.flex = '1.4';
      style.background = '#3b3b3b';
      content = <BackspaceIcon />;
    } else if (key === '!#1' || key === 'ABC') {
      style.flex = '1.4';
      style.background = '#3b3b3b';
      style['font-size'] = '1.1rem';
    } else if (key === 'English (AU)' || key === 'Space') {
      style.flex = '5';
      style.background = '#3b3b3b';
      style['font-size'] = '1rem';
      content = mode() === 'alpha' ? 'English (AU)' : '';
    } else if (key === 'enter') {
      style.flex = '1.4';
      style.background = '#3b3b3b';
      content = <EnterIcon />;
    } else if (key === '1/2' || key === '2/2') {
      style.flex = '1.4';
      style.background = '#3b3b3b';
      style['font-size'] = '0.9rem';
    } else if (key === ',' || key === '.') {
      style.background = '#3b3b3b';
    }

    if (mode() === 'alpha' && key.length === 1 && key.match(/[a-z]/)) {
      content = isShift() ? key.toUpperCase() : key;
    }

    return (
      <button 
        style={style} 
        onPointerDown={(e) => { e.preventDefault(); handleKeyPress(key); startRepeat(key); }}
        onPointerUp={() => stopRepeat()}
        onPointerLeave={() => stopRepeat()}
      >
        {content}
      </button>
    );
  };

  return (
    <div style={{
      'background-color': '#000',
      padding: '2px 4px',
      width: '100%',
      'max-width': '100vw',
      'box-sizing': 'border-box',
      display: 'flex',
      'flex-direction': 'column',
      gap: '4px',
      'user-select': 'none',
      'padding-bottom': 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
      'overflow': 'hidden',
      margin: '0',
      position: 'relative'
    }}>
      <div style={{
        display: 'flex',
        'justify-content': 'center',
        'align-items': 'center',
        height: '20px',
        width: '100%',
        'margin-bottom': '-2px'
      }}>
        <button 
          onPointerDown={(e) => { e.preventDefault(); props.onCollapse?.(); }}
          style={{
            background: 'none',
            border: 'none',
            color: '#666',
            width: '60px',
            height: '100%',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            cursor: 'pointer'
          }}
        >
          <CollapseIcon />
        </button>
      </div>
      <div style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '1px',
        'background-color': '#000',
        'padding-bottom': '4px',
        'box-sizing': 'border-box'
      }}>
        <For each={extraRows}>
          {(row) => (
            <div style={{ display: 'flex', gap: '1px', height: '28px', 'box-sizing': 'border-box', width: '100%' }}>
              <For each={row}>
                {(key) => renderExtraKey(key)}
              </For>
            </div>
          )}
        </For>
      </div>
      <For each={layouts[mode()]}>
        {(row, index) => (
          <div style={{
            display: 'flex',
            gap: '4px',
            'justify-content': 'center',
            width: '100%',
            padding: index() === 2 ? '0 5%' : '0',
            'box-sizing': 'border-box'
          }}>
            <For each={row}>
              {(key) => renderKey(key)}
            </For>
          </div>
        )}
      </For>
    </div>
  );
};

export default VirtualKeyboard;

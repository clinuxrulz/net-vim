import { For, type Component } from 'solid-js';

interface ExtraKeysProps {
  onKeyPress: (key: string, ctrl?: boolean) => void;
}

export const ExtraKeys: Component<ExtraKeysProps> = (props) => {
  const keys = [
    { label: 'ESC', key: 'Escape' },
    { label: 'TAB', key: 'Tab' },
    { label: 'CTRL', key: 'Control', toggle: true },
    { label: '←', key: 'ArrowLeft' },
    { label: '↓', key: 'ArrowDown' },
    { label: '↑', key: 'ArrowUp' },
    { label: '→', key: 'ArrowRight' },
    { label: ':', key: ':' },
    { label: '/', key: '/' },
  ];

  return (
    <div style={{
      display: 'flex',
      'flex-wrap': 'wrap',
      'justify-content': 'center',
      gap: '6px',
      padding: '8px',
      background: '#222',
      'border-top': '1px solid #444',
      width: '100%',
      'box-sizing': 'border-box'
    }}>
      <For each={keys}>
        {(k) => (
          <button
            onPointerDown={(e) => { e.preventDefault(); props.onKeyPress(k.key); }}
          >
            {k.label}
          </button>
        )}
      </For>
    </div>
  );
};

import { For, Show, type Component, createEffect } from 'solid-js';
import type { VimMode, GutterOptions } from './types';
import { h } from './solid-universal-tui';

interface VimUIProps {
  buffer: string[] | (() => string[]);
  cursor: { x: number; y: number } | (() => { x: number; y: number });
  topLine?: number | (() => number);
  leftCol?: number | (() => number);
  mode: VimMode | (() => VimMode);
  commandText: string | (() => string);
  width: number | (() => number);
  height: number | (() => number);
  currentFilePath?: string | null | (() => string | null);
  isExplorer?: boolean | (() => boolean);
  explorerPath?: string | (() => string);
  isReadOnly?: boolean | (() => boolean);
  plugins?: Array<{ name: string }> | (() => Array<{ name: string }>);
  gutters?: GutterOptions[] | (() => GutterOptions[]);
  onCursorChange?: (cursor: { x: number; y: number }) => void;
}

export const VimUI: Component<VimUIProps> = (props) => {
  const getProp = <T,>(val: T | (() => T)): T => (typeof val === 'function' ? (val as Function)() : val);

  const buffer = () => getProp(props.buffer) || [];
  const cursor = () => getProp(props.cursor) || { x: 0, y: 0 };
  const topLine = () => getProp(props.topLine) || 0;
  const leftCol = () => getProp(props.leftCol) || 0;
  const mode = () => getProp(props.mode) || 'Normal';
  const commandText = () => getProp(props.commandText) || '';
  const width = () => getProp(props.width) || 80;
  const height = () => getProp(props.height) || 24;
  const currentFilePath = () => getProp(props.currentFilePath);
  const isExplorer = () => getProp(props.isExplorer);
  const explorerPath = () => getProp(props.explorerPath);
  const isReadOnly = () => getProp(props.isReadOnly);
  const gutters = () => getProp(props.gutters) || [];

  const statusLineY = () => height() - 2;
  const commandLineY = () => height() - 1;
  const viewportHeight = () => height() - 2;

  const totalGutterWidth = () => gutters().reduce((acc, g) => acc + g.width, 0);
  const viewportWidth = () => width() - totalGutterWidth();

  createEffect(() => {
    if (props.onCursorChange) {
      const visualX = cursor().x - leftCol() + totalGutterWidth();
      const visualY = cursor().y - topLine();
      props.onCursorChange({ x: visualX, y: visualY });
    }
  });

  const fileName = () => {
    if (isExplorer()) return `Explorer: ${explorerPath() || '/'}`;
    return (currentFilePath() || '[No Name]') + (isReadOnly() ? ' [RO]' : '');
  };

  const visibleLines = () => buffer().slice(topLine(), topLine() + viewportHeight());

  return h('box', { x: 0, y: 0, width: width, height: height, border: false }, [
    /* Gutters & Buffer View */
    h(For, { each: visibleLines }, (line: string, i: () => number) => {
      const absoluteLineIndex = () => topLine() + i();
      return h('box', { x: 0, y: i, width: width, height: 1 }, [
        h(For, { each: gutters }, (gutter: GutterOptions, index: () => number) => {
          const x = () => gutters().slice(0, index()).reduce((acc, g) => acc + g.width, 0);
          return h('box', { x: x, y: 0, width: () => gutter.width, height: 1 }, [
            gutter.render({ 
              lineIndex: absoluteLineIndex, 
              lineContent: line, 
              isCursorLine: () => cursor().y === absoluteLineIndex() 
            })
          ]);
        }),
        h('text', { x: totalGutterWidth, y: 0, content: () => line.slice(leftCol(), leftCol() + viewportWidth()) })
      ]);
    }),

    /* Status Line */
    h('box', { x: 0, y: statusLineY, width: width, height: 1, border: false }, [
      h('text', { x: 0, y: 0, content: () => `-- ${mode().toUpperCase()} --   ${fileName()}   ${cursor().y + 1},${cursor().x + 1}` })
    ]),

    /* Command Line / Message Area */
    h('box', { x: 0, y: commandLineY, width: width, height: 1, border: false }, [
      h(Show, { when: () => mode() === 'Command' }, [
        h('text', { x: 0, y: 0, content: () => `:${commandText()}` })
      ])
    ])
  ]);
};

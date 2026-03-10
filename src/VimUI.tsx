import { For, Show, type Component, createEffect, Index } from 'solid-js';
import type { VimMode, GutterOptions, LineRendererOptions } from './types';

interface VimUIProps {
  buffer: string[] | (() => string[]);
  cursor: { x: number; y: number } | (() => { x: number; y: number });
  visualStart?: { x: number; y: number } | null | (() => { x: number; y: number } | null);
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
  lineRenderers?: LineRendererOptions[] | (() => LineRendererOptions[]);
  completionItems?: any[] | (() => any[]);
  selectedCompletionIndex?: number | (() => number);
  hoverText?: string | null | (() => string | null);
  hoverPos?: { x: number; y: number } | (() => { x: number; y: number });
  onCursorChange?: (cursor: { x: number; y: number }) => void;
}

export const VimUI: Component<VimUIProps> = (props) => {
  const getProp = <T,>(val: T | (() => T)): T => (typeof val === 'function' ? (val as Function)() : val);

  const buffer = () => getProp(props.buffer) || [];
  const cursor = () => getProp(props.cursor) || { x: 0, y: 0 };
  const visualStart = () => getProp(props.visualStart) ?? null;
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
  const lineRenderers = () => getProp(props.lineRenderers) || [];
  const completionItems = () => getProp(props.completionItems) || [];
  const selectedCompletionIndex = () => getProp(props.selectedCompletionIndex) || 0;
  const hoverText = () => getProp(props.hoverText);
  const hoverPos = () => getProp(props.hoverPos) || { x: 0, y: 0 };

  const statusLineY = () => height() - 2;
  const commandLineY = () => height() - 1;
  const viewportHeight = () => height() - 2;

  const totalGutterWidth = () => gutters().reduce((acc, g) => acc + g.width, 0);
  const viewportWidth = () => width() - totalGutterWidth();

  const visualCursorX = () => cursor().x - leftCol() + totalGutterWidth();
  const visualCursorY = () => cursor().y - topLine();

  const lineRenderer = () => lineRenderers()[0];

  createEffect(() => {
    if (props.onCursorChange) {
      props.onCursorChange({ x: visualCursorX(), y: visualCursorY() });
    }
  });

  const fileName = () => {
    if (isExplorer()) return `Explorer: ${explorerPath() || '/'}`;
    return (currentFilePath() || '[No Name]') + (isReadOnly() ? ' [RO]' : '');
  };

  const visibleLines = () => buffer().slice(topLine(), topLine() + viewportHeight());

  const MAX_COMPLETIONS = 6;
  const completionStartIndex = () => {
    const items = completionItems();
    const selected = selectedCompletionIndex();
    if (items.length <= MAX_COMPLETIONS) return 0;
    
    // Keep selection visible
    if (selected < MAX_COMPLETIONS / 2) return 0;
    if (selected > items.length - MAX_COMPLETIONS / 2) return items.length - MAX_COMPLETIONS;
    return Math.floor(selected - MAX_COMPLETIONS / 2);
  };

  const visibleCompletions = () => {
    const start = completionStartIndex();
    return completionItems().slice(start, start + MAX_COMPLETIONS);
  };

  const hoverLines = () => (hoverText() || '').split('\n');
  const hoverHeight = () => hoverLines().length + 2;
  const hoverWidth = () => Math.max(20, Math.min(40, ...hoverLines().map(l => l.length + 2)));

  const popupHeight = () => visibleCompletions().length + 2;
  const popupY = () => {
    const yBelow = visualCursorY() + 1;
    const h = popupHeight();
    // If it doesn't fit below, try above
    if (yBelow + h > height()) {
      const yAbove = visualCursorY() - h;
      return Math.max(0, yAbove);
    }
    return yBelow;
  };
  const popupX = () => Math.max(0, Math.min(visualCursorX(), width() - 30));

  return (
    <tui-box x={0} y={0} width={width()} height={height()} border={false}>
      {/* Gutters & Buffer View */}
      <Index each={visibleLines()}>
        {(line: () => string, i: number) => {
          const absoluteLineIndex = () => topLine() + i;
          return (
            <tui-box x={0} y={i} width={width()} height={1}>
              <For each={gutters()}>
                {(gutter: GutterOptions, index: () => number) => {
                  const x = () => gutters().slice(0, index()).reduce((acc, g) => acc + g.width, 0);
                  return (
                    <tui-box x={x()} y={0} width={gutter.width} height={1}>
                      {gutter.render({ 
                        lineIndex: absoluteLineIndex(), 
                        lineContent: line(), 
                        isCursorLine: cursor().y === absoluteLineIndex() 
                      })}
                    </tui-box>
                  );
                }}
              </For>
              <Show 
                when={lineRenderer()} 
                fallback={
                  (() => {
                    const start = visualStart();
                    if (!start || mode() !== 'Visual') {
                      return <tui-text x={totalGutterWidth()} y={0} content={line().slice(leftCol(), leftCol() + viewportWidth())} />;
                    }

                    const end = cursor();
                    const lineIdx = absoluteLineIndex();
                    const lineContent = line();
                    const len = lineContent.length;

                    let s = start;
                    let e = end;
                    if (s.y > e.y || (s.y === e.y && s.x > e.x)) {
                      [s, e] = [e, s];
                    }

                    if (lineIdx < s.y || lineIdx > e.y) {
                      return <tui-text x={totalGutterWidth()} y={0} content={lineContent.slice(leftCol(), leftCol() + viewportWidth())} />;
                    }

                    let highlightStart = 0;
                    let highlightEnd = len;

                    if (lineIdx === s.y) highlightStart = s.x;
                    if (lineIdx === e.y) highlightEnd = e.x;

                    // Ensure highlightEnd is inclusive for the character at the cursor
                    // in visual mode
                    highlightEnd = Math.min(len, highlightEnd + 1);

                    const before = lineContent.slice(leftCol(), Math.max(leftCol(), highlightStart));
                    const selected = lineContent.slice(Math.max(leftCol(), highlightStart), Math.min(leftCol() + viewportWidth(), highlightEnd));
                    const after = lineContent.slice(Math.max(leftCol(), highlightEnd), leftCol() + viewportWidth());

                    return (
                      <tui-box x={totalGutterWidth()} y={0} width={viewportWidth()} height={1}>
                        <tui-text x={0} y={0} content={before} />
                        <tui-text x={before.length} y={0} content={selected} bg_color="#004b72" />
                        <tui-text x={before.length + selected.length} y={0} content={after} />
                      </tui-box>
                    );
                  })()
                }
              >
                <tui-box x={totalGutterWidth()} y={0} width={viewportWidth()} height={1}>
                  {() => lineRenderer()?.render({
                    lineIndex: absoluteLineIndex,
                    lineContent: line(),
                    isCursorLine: () => cursor().y === absoluteLineIndex(),
                    gutterWidth: totalGutterWidth,
                    leftCol: leftCol,
                    viewportWidth: viewportWidth,
                    visualStart: visualStart(),
                    mode: mode()
                  })}
                </tui-box>
              </Show>
            </tui-box>
          );
        }}
      </Index>

      {/* Status Line */}
      <tui-box x={0} y={statusLineY()} width={width()} height={1} border={false}>
        <tui-text x={0} y={0} content={`-- ${mode().toUpperCase()} --   ${fileName()}   ${cursor().y + 1},${cursor().x + 1}`} />
      </tui-box>

      {/* Command Line / Message Area */}
      <tui-box x={0} y={commandLineY()} width={width()} height={1} border={false}>
        <Show when={mode() === 'Command'}>
          <tui-text x={0} y={0} content={`:${commandText()}`} />
        </Show>
      </tui-box>

      {/* Completion Popup */}
      <Show when={completionItems().length > 0}>
        <tui-box 
          x={popupX()} 
          y={popupY()} 
          width={30} 
          height={popupHeight()}
          border={true}
          title='Completions'
        >
          <For each={visibleCompletions()}>
            {(item: any, i: () => number) => {
              const isSelected = () => (i() + completionStartIndex()) === selectedCompletionIndex();
              return (
                <tui-text 
                  x={1} 
                  y={i() + 1} 
                  content={(isSelected() ? '> ' : '  ') + item.label.slice(0, 26)}
                  color={isSelected() ? '#007acc' : '#ffffff'}
                />
              );
            }}
          </For>
        </tui-box>
      </Show>

      {/* Hover Info */}
      <Show when={hoverText()}>
        <tui-box
          x={Math.min(hoverPos().x, width() - hoverWidth())}
          y={Math.max(0, hoverPos().y - hoverHeight())}
          width={hoverWidth()}
          height={hoverHeight()}
          border={true}
        >
          <For each={hoverLines()}>
            {(line, i) => (
              <tui-text x={1} y={i() + 1} content={line} />
            )}
          </For>
        </tui-box>
      </Show>
    </tui-box>
  );
};

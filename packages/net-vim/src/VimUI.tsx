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
  commandCursorX?: number | (() => number);
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
  statusMessage?: string | null | (() => string | null);
  wrap: boolean | (() => boolean);
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
  const commandCursorX = () => getProp(props.commandCursorX) ?? 0;
  const width = () => getProp(props.width) || 80;
  const height = () => getProp(props.height) || 24;
  const currentFilePath = () => getProp(props.currentFilePath) ?? null;
  const isExplorer = () => getProp(props.isExplorer);
  const explorerPath = () => getProp(props.explorerPath);
  const isReadOnly = () => getProp(props.isReadOnly);
  const gutters = () => getProp(props.gutters) || [];
  const lineRenderers = () => getProp(props.lineRenderers) || [];
  const completionItems = () => getProp(props.completionItems) || [];
  const selectedCompletionIndex = () => getProp(props.selectedCompletionIndex) || 0;
  const hoverText = () => getProp(props.hoverText);
  const hoverPos = () => getProp(props.hoverPos) || { x: 0, y: 0 };
  const statusMessage = () => getProp(props.statusMessage);
  const wrap = () => getProp(props.wrap);

  const statusLineY = () => height() - 2;
  const commandLineY = () => height() - 1;
  const viewportHeight = () => height() - 2;

  const totalGutterWidth = () => gutters().reduce((acc, g) => acc + g.width, 0);
  const viewportWidth = () => width() - totalGutterWidth();

  const renderLine = (absoluteLineIndex: () => number, lineContent: string, localLeftCol: number) => {
    const renderers = lineRenderers();
    for (const renderer of renderers) {
      const result = renderer.render({
        lineIndex: absoluteLineIndex,
        lineContent: lineContent,
        isCursorLine: () => cursor().y === absoluteLineIndex(),
        gutterWidth: totalGutterWidth,
        leftCol: () => localLeftCol,
        viewportWidth: viewportWidth,
        visualStart: visualStart(),
        mode: mode(),
        cursor: cursor(),
        currentFilePath: currentFilePath
      });
      if (result !== undefined && result !== null) return result;
    }
    return null;
  };

  const visualCursorY = () => {
    if (mode() === 'Command') return commandLineY();

    const c = cursor();
    const start = topLine();
    const vWidth = viewportWidth();
    const buf = buffer();
    
    if (c.y < start) return -1;
    
    let y = 0;
    for (let i = start; i < c.y; i++) {
      if (wrap()) {
        y += Math.max(1, Math.ceil((buf[i]?.length || 0) / vWidth));
      } else {
        y += 1;
      }
    }
    
    if (wrap()) {
      y += Math.floor(c.x / vWidth);
    }
    
    return y;
  };

  const visualCursorX = () => {
    if (mode() === 'Command') return commandCursorX() + 1; // +1 for ':'

    const c = cursor();
    const vWidth = viewportWidth();
    const gWidth = totalGutterWidth();
    
    if (wrap()) {
      return (c.x % vWidth) + gWidth;
    } else {
      return c.x - leftCol() + gWidth;
    }
  };

  createEffect(() => {
    if (props.onCursorChange) {
      props.onCursorChange({ x: visualCursorX(), y: visualCursorY() });
    }
  });

  const fileName = () => {
    if (isExplorer()) return `Explorer: ${explorerPath() || '/'}`;
    return (currentFilePath() || '[No Name]') + (isReadOnly() ? ' [RO]' : '');
  };

  const displayLines = () => {
    const lines = buffer();
    const start = topLine();
    const vHeight = viewportHeight();
    const vWidth = viewportWidth();
    
    const result: Array<{
      content: string;
      bufferIndex: number;
      isFirstDisplayRow: boolean;
      rowInLine: number;
    }> = [];
    
    let currentY = 0;
    for (let i = start; i < lines.length && currentY < vHeight; i++) {
      const line = lines[i];
      if (wrap()) {
        const rows = [];
        if (line.length === 0) {
          rows.push("");
        } else {
          for (let j = 0; j < line.length; j += vWidth) {
            rows.push(line.slice(j, j + vWidth));
          }
        }
        
        for (let j = 0; j < rows.length && currentY < vHeight; j++) {
          result.push({
            content: rows[j],
            bufferIndex: i,
            isFirstDisplayRow: j === 0,
            rowInLine: j
          });
          currentY++;
        }
      } else {
        result.push({
          content: line.slice(leftCol(), leftCol() + vWidth),
          bufferIndex: i,
          isFirstDisplayRow: true,
          rowInLine: 0
        });
        currentY++;
      }
    }
    return result;
  };

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
      <Index each={displayLines()}>
        {(item, i) => {
          const absoluteLineIndex = () => item().bufferIndex;
          const isCursorLine = () => cursor().y === absoluteLineIndex();
          const lineContent = () => buffer()[absoluteLineIndex()] || "";

          return (
            <tui-box x={0} y={i} width={width()} height={1}>
              <For each={gutters()}>
                {(gutter: GutterOptions, index: () => number) => {
                  const x = () => gutters().slice(0, index()).reduce((acc, g) => acc + g.width, 0);
                  return (
                    <tui-box x={x()} y={0} width={gutter.width} height={1}>
                      <Show when={item().isFirstDisplayRow}>
                        {gutter.render({ 
                          lineIndex: absoluteLineIndex(), 
                          lineContent: lineContent(), 
                          isCursorLine: isCursorLine() 
                        })}
                      </Show>
                    </tui-box>
                  );
                }}
              </For>
              {(() => {
                const localLeftCol = wrap() ? item().rowInLine * viewportWidth() : leftCol();
                const result = renderLine(absoluteLineIndex, lineContent(), localLeftCol);
                
                if (result) {
                  return (
                    <tui-box x={totalGutterWidth()} y={0} width={viewportWidth()} height={1}>
                      {result}
                    </tui-box>
                  );
                }

                // Fallback rendering
                const start = visualStart();
                const lineIdx = absoluteLineIndex();
                const rowContent = item().content;
                const vWidth = viewportWidth();
                const gWidth = totalGutterWidth();

                if (!start || mode() !== 'Visual') {
                  return <tui-text x={gWidth} y={0} content={rowContent} />;
                }

                const end = cursor();
                let s = start;
                let e = end;
                if (s.y > e.y || (s.y === e.y && s.x > e.x)) {
                  [s, e] = [e, s];
                }

                if (lineIdx < s.y || lineIdx > e.y) {
                  return <tui-text x={gWidth} y={0} content={rowContent} />;
                }

                const rowStartOffset = item().rowInLine * vWidth;
                const rowEndOffset = rowStartOffset + vWidth;

                let highlightStartInLine = 0;
                let highlightEndInLine = lineContent().length;

                if (lineIdx === s.y) highlightStartInLine = s.x;
                if (lineIdx === e.y) highlightEndInLine = e.x + 1;

                const highlightStart = Math.max(rowStartOffset, highlightStartInLine);
                const highlightEnd = Math.min(rowEndOffset, highlightEndInLine);

                if (highlightStart >= highlightEnd) {
                   return <tui-text x={gWidth} y={0} content={rowContent} />;
                }

                const relStart = Math.max(0, highlightStart - rowStartOffset);
                const relEnd = Math.min(vWidth, highlightEnd - rowStartOffset);

                const before = rowContent.slice(0, relStart);
                const selected = rowContent.slice(relStart, relEnd);
                const after = rowContent.slice(relEnd);

                return (
                  <tui-box x={gWidth} y={0} width={vWidth} height={1}>
                    <tui-text x={0} y={0} content={before} />
                    <tui-text x={before.length} y={0} content={selected} bg_color="#004b72" />
                    <tui-text x={before.length + selected.length} y={0} content={after} />
                  </tui-box>
                );
              })()}
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
        <Show when={mode() !== 'Command' && statusMessage()}>
          <tui-text x={0} y={0} content={statusMessage()} />
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

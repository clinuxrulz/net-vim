import { For, Show, type Component } from 'solid-js';
import type { VimMode } from './types';

interface VimUIProps {
  buffer: string[];
  cursor: { x: number; y: number };
  mode: VimMode;
  commandText: string;
  width: number;
  height: number;
  currentFilePath?: string | null;
  isExplorer?: boolean;
  explorerPath?: string;
  plugins?: Array<{ name: string }>;
}

export const VimUI: Component<VimUIProps> = (props) => {
  const statusLineY = () => props.height - 2;
  const commandLineY = () => props.height - 1;

  const fileName = () => {
    if (props.isExplorer) return `Explorer: ${props.explorerPath || '/'}`;
    return props.currentFilePath || '[No Name]';
  };

  return (
    <box x={0} y={0} width={props.width} height={props.height} border={false}>
      {/* Buffer View */}
      <For each={props.buffer}>
        {(line, i) => (
          <text x={0} y={i()} content={line} />
        )}
      </For>

      {/* Cursor - simulated with a character with different background if possible? 
          Actually, the current TUI engine might not support setting bg for specific chars easily via <text>.
          Wait, let's check how the Rust engine handles it.
          The WebGLRenderer takes fgs and bgs.
      */}
      
      {/* Status Line */}
      <box x={0} y={statusLineY()} width={props.width} height={1} border={false}>
         <text x={0} y={0} content={`-- ${props.mode.toUpperCase()} --   ${fileName()}   ${props.cursor.y + 1},${props.cursor.x + 1}`} />
      </box>

      {/* Command Line / Message Area */}
      <box x={0} y={commandLineY()} width={props.width} height={1} border={false}>
        <Show when={props.mode === 'Command'}>
          <text x={0} y={0} content={`:${props.commandText}`} />
        </Show>
      </box>
    </box>
  );
};

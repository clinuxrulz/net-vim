# Net-Vim

Net-Vim is a web-based Vim-compatible editor engine and component library. It provides a terminal-like editing experience within web applications using a custom TUI engine and WebGL renderer.

## Features

- Vim-compatible modal editing.
- Framework-agnostic initialization.
- WebGL-accelerated rendering.
- Plugin system with TypeScript support.
- File system abstraction using OPFS (Origin Private File System).
- Integrated virtual keyboard for mobile devices.

## Installation

```bash
npm install @net-vim/core
```

## Usage

### Framework-Agnostic Initialization

The editor can be initialized into any HTML element without requiring a specific frontend framework.

```javascript
import { initNetVim } from '@net-vim/core';

const container = document.getElementById('editor-container');
const { vim, dispose } = await initNetVim(container);

// Access the Vim API
vim.getAPI().registerCommand('hello', () => {
  console.log('Hello from Net-Vim');
});
```

### Solid.js Component

For applications using Solid.js, the editor is available as a component.

```tsx
import { VimEditor } from '@net-vim/core';

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <VimEditor ref={(vim) => console.log('Editor initialized')} />
    </div>
  );
}
```

## Configuration

Net-Vim looks for an initialization script at `.config/net-vim/init.ts` within the OPFS. You can use this to load plugins and configure the editor on startup.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

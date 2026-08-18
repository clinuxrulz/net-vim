# Net-Vim

[![npm version](https://img.shields.io/npm/v/@net-vim/core.svg)](https://www.npmjs.com/package/@net-vim/core)

Net-Vim is a web-based Vim-compatible editor engine and component library. It provides a terminal-like editing experience within web applications using a custom TUI engine and WebGL renderer.

**[Live Demo](https://clinuxrulz.github.io/net-vim/)**

## Features

- Vim-compatible modal editing.
- Framework-agnostic initialization.
- WebGL-accelerated rendering, with an alternative DOM renderer.
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

### Lua plugins (Neovim-style API)

Net-Vim ships an embedded Lua 5.4 runtime (wasmoon) plus a Neovim-compatible `vim.*` API, so you can run many existing Neovim Lua plugins that don't require native execution (no libuv, Treesitter, or `vim.lsp`).

On startup, if `.config/net-vim/init.lua` exists it runs after `init.ts`. Lua modules for `require(...)` are resolved from `.config/net-vim/lua/**` (e.g. `require('foo.bar')` -> `.config/net-vim/lua/foo/bar.lua` or `.../foo/bar/init.lua`).

```lua
-- .config/net-vim/init.lua
vim.g.mapleader = ' '

vim.keymap.set('n', '<leader>f', ':fuzzyFiles<CR>')

vim.api.nvim_create_user_command('LineCount', function(opts)
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  vim.notify('buffer has ' .. #lines .. ' lines')
end, {})

vim.api.nvim_create_autocmd('BufWritePost', {
  pattern = '*.lua',
  callback = function() vim.g.saved = vim.fn.expand('%') end,
})
```

Supported surface (curated subset):

- `vim.api.nvim_*` — buffers/lines, current cursor & line, options, vars, commands, autocmds/augroups, namespaces & extmarks (metadata), termcodes, `nvim_command`/`nvim_exec`.
- `vim.cmd` (string, table, and `vim.cmd.SomeCommand('args')`), `vim.keymap.set/del/clear` (with `<leader>`/`<C-x>`/`<CR>` translation), `vim.opt/opt_local/opt_global`, `vim.o/bo/wo`, `vim.g/b/w/v/env`, `vim.NIL`, `vim.empty_dict()`, `vim.inspect`, `vim.keycode`, `vim.deepcopy`, `vim.iter`, `vim.tbl_*`, `vim.list_extend`, `vim.fs`, `vim.fn` (small logic registry), `vim.schedule`, `vim.defer_fn`, `vim.wait`.
- Plugins are run once, then `require('<name>')` is populated so `.setup({})` is called automatically (matching lazy/paq conventions).

Loading a Lua plugin from a TypeScript/`init.ts` plugin:

```ts
await api.loadLuaPluginFromSource('my-plugin', luaSourceString);
```

Not implemented (deliberately out of scope): `vim.lsp`, `vim.loop`/`vim.uv` libuv bindings, and `vim.fn` functions that require native execution. Plugin authors should also note `vim.wait` uses a busy loop (it does not yield to the browser event loop).

### which-key (`require("which-key")`)

The upstream [folke/which-key.nvim](https://github.com/folke/which-key.nvim) (tag `v3.17.0`, MIT) is bundled and runs unmodified through the Lua runtime. It is resolved from `lua/which-key/**` (a read-only virtual prelude; your `.config/net-vim/lua/which-key/**` files override it).

To use it, call `setup()` from `.config/net-vim/init.lua`:

```lua
local wk = require('which-key')
wk.setup({
  -- plugins that need register/spell APIs Net-Vim does not ship are disabled
  plugins = { marks = false, registers = false, spelling = { enabled = false } },
  spec = {
    { '<leader>', group = 'Leader' },
    { '<leader>l', '<cmd>LuaHello<CR>', desc = 'LuaHello' },
    { '<leader>f', group = 'File' },
    { '<leader>ff', '<cmd>fuzzyFiles<CR>', desc = 'Fuzzy find' },
  },
})
```

Press `<leader>` (space by default) to open a popup listing your leader mappings; type the next key to drill into a group (type-to-filter), use `j`/`k`/arrows to navigate, `<CR>` to run a leaf, `<BS>` to go back, `<Esc>` to close. `:WhichKey [mode] [keys]` also opens a popup directly.

How it works under the hood:

- **Blocking `getchar`**: which-key drives type-to-filter with a blocking `vim.fn.getcharstr()` loop. Net-Vim runs every Lua keymap callback inside a Lua coroutine; when the plugin calls `getcharstr` and no key is queued, the coroutine yields and the engine resumes it on the next `handleKey` (the same semantics as Neovim's `getchar`).
- **Floating windows**: `nvim_open_win`/`nvim_win_set_config`/… are backed by an in-engine float-window registry rendered as a TUI overlay (like the picker), so the popup and its footer draw without needing a window model.
- **Keymap introspection**: `vim.api.nvim_get_keymap`, `vim.fn.maparg`, `vim.keymap.set/del` (with `desc`/`nowait`/`buffer`), `vim.fn.replace_termcodes` and the Lua table helpers (`vim.tbl_*`, `vim.deepcopy`, `vim.split`, `vim.deep_extend`…) are implemented consistently with the engine's key-map matching. `<leader>` expands to the literal leader key (`' '`), `<C-x>` stays a single key token, and `nvim_get_mode` returns Neovim-style mode letters.
- **`vim.uv` timers** and `vim.schedule_wrap` round out the runtime the plugin relies on.

The vendored source lives in `packages/net-vim/src/lua-plugins/which-key/` and is shipped via the bundled module loader (`src/lua-plugins/index.ts`).

### Treesitter (`vim.treesitter`)

Net-Vim also embeds a tree-sitter runtime (`web-tree-sitter`), exposed to Lua through `vim.treesitter.*`:

- `vim.treesitter.get_parser(buf, lang)` / `get_string_parser(src, lang)` / `get_node`, `vim.treesitter.get_captures_at_pos`.
- `vim.treesitter.query.get_query/compile/parse`, with `q:iter_captures()` / `q:iter_matches()` usable directly in Lua generic-for loops.
- `vim.treesitter.start(buf, lang)` / `stop()` plus `vim.treesitter.highlighter.active[buf]`, which highlight the buffer via a line renderer using the built-in `highlights.scm` queries and a Neovim-ish color scheme.
- Node API: `node:type()`, `:start()`, `:end_()`, `:range()`, `:text()`, `:child()`, `:named_child()`, `:field()`, `:parent()`, `:iter_children()`, `:has_error()`, and more.

Grammars are fetched at runtime from `@vscode/tree-sitter-wasm` (bash, c-sharp, cpp, css, go, ini, java, javascript, php, powershell, python, regex, ruby, rust, tsx, typescript) and cached in OPFS. **Lua is bundled directly** (compiled for the web-tree-sitter ABI, with the grammar's official `highlights.scm`), so `vim.treesitter.start(buf, 'lua')` and `get_parser` for Lua files work out of the box with no network access. Common languages are preloaded in the background so `get_parser()` is synchronous for them; grammars for other languages load on demand (the first `get_parser` for a not-yet-loaded language returns `nil` and triggers a background load). For languages outside the bundled+CDN set (e.g. JSON/Markdown/TOML/YAML), place a grammar at `.config/net-vim/grammars/tree-sitter-<lang>.wasm` or provide a `readGrammarBytes` callback via `LuaPluginVM`/`configureLuaRuntime`.



### Renderer

The editor defaults to the WebGL renderer. Switch to the DOM renderer (or back) from within the editor:

```vim
:renderer dom
:renderer webgl
```

Using `:renderer` with no argument toggles between the two renderers.

### Native/system virtual keyboard

On mobile, type `:syskb` (or `:syskb` again to close it) to summon the native OS virtual keyboard via a hidden contenteditable, keeping the navigation row (arrows, ESC, TAB, CTRL, ALT, etc.) above it. The editor view shrinks automatically to stay above the keyboard. Tapping the buffer still opens the built-in custom virtual keyboard as before.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

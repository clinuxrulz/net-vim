# Net-Vim Help

Welcome to Net-Vim, a TUI-based editor running in your browser!

## Modes
- **Normal Mode**: The default mode for navigation and commands. Press `Esc` to return here.
- **Insert Mode**: For typing text. Press `i` to enter.
- **Visual Mode**: For selecting text. Press `v` to enter/exit.
- **Command Mode**: For entering colon commands. Press `:` to enter.

## Navigation (Normal/Visual)
- `h`, `j`, `k`, `l` or **Arrow Keys**: Move cursor left, down, up, right.
- `Home` / `End`: Move to start/end of line.
- `PageUp` / `PageDown`: Scroll up/down by a page.
- `Ctrl-u` / `Ctrl-d`: Scroll up/down by half a page.
- `Ctrl-y` / `Ctrl-e`: Scroll up/down by one line.

## Editing (Normal)
- `i`: Enter Insert Mode at cursor.
- `x`: Delete character under cursor.
- `dd`: Delete current line (and yank to clipboard).
- `yy`: Yank current line to clipboard.
- `p`: Put clipboard content after cursor (Normal) or replace selection (Visual).

## Editing (Visual)
- `d` or `x`: Delete selection (and yank to clipboard).
- `y`: Yank selection to clipboard.
- `p`: Replace selection with clipboard content.

## Commands (Command Mode)
- `:w [file]`: Save current buffer to file.
- `:e [file]`: Open a file or directory. Use `.` for root.
- `:q`: Quit (currently just logs to console).
- `:set wrap`: Enable line wrapping.
- `:set nowrap`: Disable line wrapping.
- `:set wrap!`: Toggle line wrapping.

## LSP & Diagnostics (Normal)
- `leader d` or `Ctrl-w d`: Show diagnostics for current line.
- `[d`: Go to previous diagnostic.
- `]d`: Go to next diagnostic.
- `leader e`: Show hover information (e.g., types, documentation).

*Note: The 'leader' key is currently set to `Space`.*

## Explorer
- When opening a directory, use `j`/`k` to navigate and `Enter` to open a file or subdirectory.
- Select `../` to go up one directory.

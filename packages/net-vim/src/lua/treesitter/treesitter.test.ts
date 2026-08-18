// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { configureLuaRuntime } from '../../lua-runtime';
import { LuaPluginVM } from '../lua-vm';
import type { LuaBackend } from '../backend';

const nodeRequire = createRequire(import.meta.url);
const glueWasm = nodeRequire.resolve('wasmoon/dist/glue.wasm');

let grammarPath: string;
try {
  grammarPath = nodeRequire.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm');
} catch {
  grammarPath = '';
}

const readJavascriptGrammar = async (lang: string): Promise<Uint8Array | null> => {
  if (lang === 'javascript' && grammarPath) {
    return new Uint8Array(readFileSync(grammarPath));
  }
  return null;
};

const lines = ['const x = 1;', '// a comment', 'function hi() {', '  return x + 1;', '}'];

function makeBackend(): LuaBackend {
  let buffer = [...lines];
  return {
    executeCommand: () => {},
    registerCommand: () => {},
    delCommand: () => {},
    getBuffer: () => buffer,
    setBuffer: (b) => { buffer = [...b]; },
    getCurrentFilePath: () => '/proj/main.js',
    getCursor: () => ({ x: 0, y: 0 }),
    setCursor: () => {},
    getMode: () => 'Normal',
    on: (_ev, _cb) => {},
    registerKeymap: () => {},
    delKeymap: () => {},
    schedule: (cb) => setTimeout(cb, 0),
    defer: (cb, ms) => setTimeout(cb, ms),
    showMessage: () => {},
    fs: null,
  };
}

let vm: LuaPluginVM;
let registeredRenderers: any[] = [];

beforeAll(async () => {
  configureLuaRuntime({ wasmUrl: glueWasm });
  registeredRenderers = [];
  const backend = makeBackend();
  vm = await LuaPluginVM.create(backend, () => null, {
    registerLineRenderer: (opts) => { registeredRenderers.push(opts); },
    rerender: () => {},
    readGrammarBytes: readJavascriptGrammar,
    preload: false,
  });
  await vm.treesitter.loader.get('javascript');
});

afterAll(() => vm.close());

describe('vim.treesitter (real web-tree-sitter)', () => {
  it('get_parser parses and exposes the root node', async () => {
    const out = await vm.run(`
      local p = vim.treesitter.get_parser(1, 'javascript')
      local ok = p ~= nil
      local root = p:root()
      local rootType = root:type()
      local childType = root:named_child(0):type()
      return tostring(ok) .. '|' .. rootType .. '|' .. childType
    `);
    expect(out).toBe('true|program|lexical_declaration');
  });

  it('node traversal: text, range, fields, siblings', async () => {
    const out = await vm.run(`
      local p = vim.treesitter.get_parser(1, 'javascript')
      local root = p:root()
      local n2 = root:named_child(2)
      local sr, sc, er, ec = n2:range()
      local type_ = n2:type()
      local parentType = n2:parent():type()
      local isFunc = n2:text():find('function hi', 1, true) ~= nil
      return type_ .. '|' .. sr .. ':' .. sc .. '-' .. er .. ':' .. ec .. '|' .. tostring(isFunc) .. '|' .. parentType
    `);
    expect(out).toBe('function_declaration|2:0-4:1|true|program');
  });

  it('query iter_captures works in a Lua generic-for loop', async () => {
    const out = await vm.run(`
      local p = vim.treesitter.get_parser(1, 'javascript')
      local root = p:root()
      local q = vim.treesitter.query.get_query('javascript', 'highlights')
      local count = 0
      local firstCap = nil
      local names = {}
      for id, node in q:iter_captures(root, 1) do
        count = count + 1
        if firstCap == nil then firstCap = q.captures[id] end
        names[q.captures[id]] = true
        lastNodeType = node:type()
      end
      return tostring(count) .. '|' .. tostring(firstCap) .. '|' .. tostring(lastNodeType) .. '|' .. tostring(names.comment ~= nil)
    `);
    const [count, first, lastType, hasComment] = String(out).split('|');
    expect(Number(count)).toBeGreaterThanOrEqual(6);
    expect(first).toBe('variable');
    expect(hasComment).toBe('true');
    expect(lastType).not.toBe('nil');
  });

  it('query iter_matches yields match tables with captures', async () => {
    const out = await vm.run(`
      local p = vim.treesitter.get_parser(1, 'javascript')
      local root = p:root()
      local q = vim.treesitter.query.compile('javascript', '(comment) @c')
      local matchedC = nil
      local firstType = nil
      for m, id in q:iter_matches(root, 1) do
        matchedC = m.pattern
        if m.captures[1] then firstType = m.captures[1]:type() end
      end
      return (tostring(matchedC) .. '|' .. tostring(firstType))
    `);
    expect(out).toBe('1|comment');
  });

  it('vim.treesitter.start + highlighter.active + get_captures_at_pos', async () => {
    const out = await vm.run(`
      local okStart = vim.treesitter.start(1, 'javascript')
      local active = vim.treesitter.highlighter.active[1] ~= nil
      local caps = vim.treesitter.get_captures_at_pos(1, 0, 10) -- inside "1"
      local capName = caps[1] and caps[1].capture or 'none'
      return tostring(okStart) .. '|' .. tostring(active) .. '|' .. capName
    `);
    expect(out).toBe('true|true|number');
  });

  it('get_node at cursor position returns the right node', async () => {
    const out = await vm.run(`
      local n = vim.treesitter.get_node({ buf = 1, pos = { row = 1, col = 0 } })
      return tostring(n ~= nil) .. '|' .. tostring(n and n:type() or 'nil')
    `);
    expect(out).toBe('true|comment');
  });

  it('string parser parses standalone source', async () => {
    const out = await vm.run(`
      local sp = vim.treesitter.get_string_parser('local a = 1 + 2', 'javascript')
      local root = sp:root()
      return root:type() .. '|' .. tostring(root:named_child_count())
    `);
    expect(out).toBe('program|1');
  });

  it('vim.treesitter.start registers a line renderer that emits colored tokens', async () => {
    await vm.run(`vim.treesitter.start(1, 'javascript')`);
    const renderer = registeredRenderers.find((r) => r.name === 'treesitter-highlighter');
    expect(renderer).toBeTruthy();
    // line 2 = "function hi() {" -> keyword/function tokens present
    const tokens = renderer.render({
      lineIndex: () => 2,
      lineContent: () => 'function hi() {',
      leftCol: () => 0,
      viewportWidth: () => 40,
    });
    const rendered = Array.isArray(tokens) ? tokens : [tokens];
    const colors = rendered.map((t: any) => t?.props?.color);
    expect(colors).toContain('#dcdcaa'); // function-name group color
    expect(rendered.some((t: any) => t?.props?.content?.includes('hi'))).toBe(true);
  });

  it('todo-comments style is_comment via get_captures_at_pos', async () => {
    const out = await vm.run(`
      -- Todo patterns like real plugins: detect comment vs code at a position
      local function is_comment(row, col)
        local caps = vim.treesitter.get_captures_at_pos(1, row, col)
        for _, c in ipairs(caps) do
          if c.capture == 'comment' then return true end
        end
        return false
      end
      return tostring(is_comment(1, 3)) .. '|' .. tostring(is_comment(0, 3))
    `);
    expect(out).toBe('true|false');
  });

  it('bundled Lua grammar works out of the box', async () => {
    await vm.treesitter.loader.get('lua'); // resolves via the bundled wasm, not CDN
    const out = await vm.run(`
      local p = vim.treesitter.get_string_parser('local x = 1\\n-- a comment\\nfunction greet()\\n  return 42\\nend', 'lua')
      local ok = p ~= nil
      local root = p:root()
      local rootType = root:type()
      local first = root:named_child(0)
      local firstType = first:type()
      -- official highlights query: local keyword + comment + function name
      local q = vim.treesitter.query.get_query('lua', 'highlights')
      local kw = nil
      local commentSeen = false
      for id, node in q:iter_captures(root, 1) do
        local name = q.captures[id]
        if name and (name:find('^keyword', 1) or name:find('^label', 1)) and kw == nil then kw = node:text() end
        if name == 'comment' then commentSeen = true end
      end
      return tostring(ok) .. '|' .. rootType .. '|' .. firstType .. '|' .. tostring(kw) .. '|' .. tostring(commentSeen)
    `);
    expect(out).toBe('true|chunk|variable_declaration|local|true');
  });

  it('lua is detected from file extension', async () => {
    const out = await vm.run(`
      local lang = vim.treesitter.language.get_lang('/path/to/mod.lua')
      local ext = vim.treesitter.language.get_extension('lua')
      return lang .. '|' .. ext
    `);
    expect(out).toBe('lua|lua');
  });
});

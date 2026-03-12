import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DOMElements, SVGElements } = require("solid-js/web/dist/dev.cjs");

export default defineConfig({
  plugins: [
    solidPlugin({
      solid: {
        moduleName: "solid-js/web",
        // @ts-ignore
        generate: "dynamic",
        renderers: [
          {
            name: "dom",
            moduleName: "solid-js/web",
            elements: [...DOMElements.values(), ...SVGElements.values()],
          },
          {
            name: "universal",
            moduleName: "universal",
            elements: ["tui-box", "tui-text", "box", "text"],
          },
        ],
      },
    }),
    wasm(),
    topLevelAwait(),
    dts({
      insertTypesEntry: true,
      compilerOptions: {
        skipLibCheck: true
      }
    })
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'WebVim',
      fileName: 'index',
      formats: ['es']
    },
    rollupOptions: {
      output: {
      }
    }
  },
  resolve: {
    alias: {
      "universal": resolve(__dirname, 'src/solid-universal-tui/index.ts')
    }
  }
});

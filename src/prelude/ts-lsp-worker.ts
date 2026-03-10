
// @ts-nocheck
import * as Comlink from "https://esm.sh/comlink@4.4.1";

let ts = null;
let vfs = null;

async function ensureTs() {
  if (!ts) {
    try {
      console.log("TS-LSP Worker: Importing TypeScript...");
      ts = await import("https://esm.sh/typescript@5.7.2");
      console.log("TS-LSP Worker: TypeScript imported. Loading @typescript/vfs...");
      vfs = await import("https://esm.sh/@typescript/vfs@1.6.4?bundle");
      
      console.log("TS-LSP Worker: Fetching standard library types...");
      const libs = [
        "lib.d.ts", 
        "lib.es5.d.ts",
        "lib.es6.d.ts",
        "lib.esnext.d.ts", 
        "lib.dom.d.ts", 
        "lib.dom.iterable.d.ts",
        "lib.es2015.d.ts",
        "lib.es2015.collection.d.ts",
        "lib.es2015.core.d.ts",
        "lib.es2015.generator.d.ts",
        "lib.es2015.iterable.d.ts",
        "lib.es2015.promise.d.ts",
        "lib.es2015.proxy.d.ts",
        "lib.es2015.reflect.d.ts",
        "lib.es2015.symbol.d.ts",
        "lib.es2015.symbol.wellknown.d.ts",
        "lib.es2016.d.ts",
        "lib.es2017.d.ts",
        "lib.es2018.d.ts",
        "lib.es2019.d.ts",
        "lib.es2020.d.ts",
        "lib.es2021.d.ts",
        "lib.es2022.d.ts"
      ];
      await Promise.all(libs.map(async (lib) => {
        try {
          const res = await fetch("https://esm.sh/typescript@5.7.2/lib/" + lib);
          if (res.ok) {
            const text = await res.text();
            fsMap.set("/" + lib, text);
            console.log("TS-LSP Worker: Loaded " + lib);
          }
        } catch (e) {
          console.warn("TS-LSP Worker: Failed to load " + lib, e);
        }
      }));
      
      console.log("TS-LSP Worker: All dependencies loaded");
    } catch (e) {
      console.error("TS-LSP Worker: Import failed!", e);
      throw e;
    }
  }
  return { ts, vfs };
}

const fsMap = new Map();

const worker = {
  env: null,
  async ping() {
    return "pong";
  },
  async initialize() {
    console.log("TS-LSP Worker: Starting initialize...");
    try {
      const { ts: tsInstance, vfs: vfsInstance } = await ensureTs();
      console.log("TS-LSP Worker: TS and VFS loaded", !!tsInstance, !!vfsInstance);
      const system = vfsInstance.createSystem(fsMap);
      const compilerOptions = {
        target: tsInstance.ScriptTarget.ESNext,
        module: tsInstance.ModuleKind.ESNext,
        moduleResolution: tsInstance.ModuleResolutionKind.Bundler,
        jsx: tsInstance.JsxEmit.Preserve,
        jsxImportSource: "solid-js",
        lib: ["esnext", "dom", "dom.iterable"],
        strict: false,
        allowNonTsExtensions: true,
        noLib: false,
        skipLibCheck: true,
      };
      
      const rootFiles = Array.from(fsMap.keys());
      console.log("TS-LSP Worker: Creating environment with root files:", rootFiles);
      this.env = vfsInstance.createVirtualTypeScriptEnvironment(system, rootFiles, tsInstance, compilerOptions);
      console.log("TS-LSP Worker: Environment created");
    } catch (e) {
      console.error("TS-LSP Worker: Initialize failed", e);
      throw e;
    }
  },

  updateFile(path, content) {
    if (!this.env) return;
    if (this.env.getSourceFile(path)) {
      this.env.updateFile(path, content);
    } else {
      this.env.createFile(path, content);
    }
  },

  async getImportedModules(path, content) {
    const { ts } = await ensureTs();
    const info = ts.preProcessFile(content);
    return info.importedFiles.map(f => f.fileName);
  },

  getLints(path) {
    if (!this.env) return [];
    const syntatic = this.env.languageService.getSyntacticDiagnostics(path);
    const semantic = this.env.languageService.getSemanticDiagnostics(path);
    return [...syntatic, ...semantic].map((d) => ({
      from: d.start,
      to: (d.start || 0) + (d.length || 0),
      message: typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText,
      category: d.category
    }));
  },

  getCompletions(path, pos) {
    if (!this.env) return null;
    const info = this.env.languageService.getCompletionsAtPosition(path, pos, {});
    if (!info) return null;
    return info.entries.map((entry) => ({
      label: entry.name,
      kind: entry.kind,
    }));
  },

  getHover(path, pos) {
    if (!this.env) return null;
    const info = this.env.languageService.getQuickInfoAtPosition(path, pos);
    if (!info) return null;
    // @ts-ignore
    const display = ts.displayPartsToString(info.displayParts);
    return {
      display,
      range: { start: info.textSpan.start, length: info.textSpan.length }
    };
  }
};

Comlink.expose(worker);

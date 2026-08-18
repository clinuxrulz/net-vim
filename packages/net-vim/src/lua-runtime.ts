import glueWasmUrl from 'wasmoon/dist/glue.wasm?url';

export interface LuaRuntimeConfig {
  wasmUrl?: string;
  env?: Record<string, string>;
}

export interface LuaEngineHandle {
  engine: any;
  close(): void;
}

let factoryPromise: Promise<any> | null = null;
let activeConfig: LuaRuntimeConfig | null = null;
let engineCount = 0;

async function loadFactory() {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      try {
        const { LuaFactory } = await import('wasmoon');
        const wasmUrl = activeConfig?.wasmUrl ?? glueWasmUrl;
        return new LuaFactory(wasmUrl, activeConfig?.env ?? {});
      } catch (err) {
        console.error('[LuaRuntime] Failed to initialize wasmoon:', err);
        throw err;
      }
    })();
  }
  return factoryPromise;
}

export function configureLuaRuntime(config: LuaRuntimeConfig) {
  activeConfig = config;
  factoryPromise = null;
}

export async function createLuaEngine(options?: {
  injectObjects?: Record<string, unknown>;
}): Promise<LuaEngineHandle> {
  const factory = await loadFactory();
  const engine = await factory.createEngine({
    openStandardLibs: true,
    injectObjects: options?.injectObjects ?? {},
  });
  engineCount++;
  return {
    engine,
    close: () => {
      try {
        engine.global.close();
      } catch {
        /* noop */
      }
    },
  };
}

export function getLuaEngineCount() {
  return engineCount;
}

export async function isLuaAvailable() {
  try {
    await loadFactory();
    return true;
  } catch {
    return false;
  }
}

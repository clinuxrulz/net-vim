declare module 'wasmoon' {
  export function decorateProxy(target: unknown, options?: { proxy?: boolean }): any;
  export class LuaFactory {
    constructor(customWasmUri?: string, environmentVariables?: Record<string, string>);
    createEngine(options?: {
      openStandardLibs?: boolean;
      injectObjects?: Record<string, unknown>;
      enableProxy?: boolean;
      traceAllocations?: boolean;
      functionTimeout?: number;
    }): Promise<any>;
    mountFile(path: string, content: string | ArrayBufferView): Promise<void>;
  }
  export const LuaLibraries: any;
  export const LuaReturn: any;
  export const LuaMultiReturn: any;
  export const decorate: any;
  export const decorateFunction: any;
  export const decorateUserdata: any;
}

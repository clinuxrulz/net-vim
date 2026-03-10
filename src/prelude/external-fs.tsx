
export default {
  metadata: {
    name: "external-fs",
    description: "Access local device folders using :ed"
  },
  setup: (api: any) => {
    const createExternalFS = (rootHandle: any) => {
      const getHandle = async (path: string, create = false) => {
        const parts = path.split("/").filter((p: string) => p.length > 0);
        
        let current = rootHandle;
        if (parts.length === 0) return { dir: current, name: "" };

        // Navigate all but last
        for (let i = 0; i < parts.length - 1; i++) {
          current = await current.getDirectoryHandle(parts[i], { create });
        }
        return { dir: current, name: parts[parts.length - 1] };
      };

      return {
        readFile: async (path: string) => {
          try {
            const { dir, name } = await getHandle(path);
            if (!name) return null; // Root is a directory
            const fileHandle = await dir.getFileHandle(name);
            const file = await fileHandle.getFile();
            return await file.text();
          } catch (e) { return null; }
        },
        writeFile: async (path: string, content: string) => {
          const { dir, name } = await getHandle(path, true);
          const fileHandle = await dir.getFileHandle(name, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(content);
          await writable.close();
        },
        listDirectory: async (path: string) => {
          try {
            let dir = rootHandle;
            if (path && path !== "." && path !== "/") {
              const parts = path.split("/").filter((p: string) => p.length > 0);
              for (const part of parts) {
                dir = await dir.getDirectoryHandle(part);
              }
            }
            const entries = [];
            // @ts-ignore
            for await (const [name, handle] of dir.entries()) {
              entries.push(handle.kind === "directory" ? name + "/" : name);
            }
            return entries;
          } catch (e: any) { 
            api.log("List dir failed: " + e.message);
            return []; 
          }
        },
        isDirectory: async (path: string) => {
          if (!path || path === "." || path === "/") return true;
          try {
            const parts = path.split("/").filter((p: string) => p.length > 0);
            let current = rootHandle;
            for (const part of parts) {
              current = await current.getDirectoryHandle(part);
            }
            return true;
          } catch (e) { return false; }
        }
      };
    };

    api.registerCommand("ed", async (args: string[]) => {
      if (args[0] === "reset" || args[0] === "opfs") {
        api.resetFS();
        api.log("Switched back to OPFS");
        api.executeCommand("e .");
        return;
      }

      if (args[0] === "bridge") {
        const port = args[1] || "8080";
        const key = args[2];
        
        if (!key) {
          api.log("Usage: :ed bridge <port> <security-key>");
          return;
        }

        const baseUrl = `http://localhost:${port}`;
        const headers = {
          'X-Bridge-Key': key
        };
        
        const bridgeFS = {
          readFile: async (path: string) => {
            try {
              const response = await fetch(`${baseUrl}/cat?path=${encodeURIComponent(path)}`, { headers });
              if (response.status === 404) return null;
              if (response.status === 401) { api.log("Bridge Error: Unauthorized (Invalid Key)"); return null; }
              if (!response.ok) return null; // Silently fail other errors to avoid log spam during probing
              return await response.text();
            } catch (err: any) {
              // Only log true network errors or crashes
              if (err.name !== 'TypeError') {
                api.log('BridgeFS readFile error: ' + err.message);
              }
              return null;
            }
          },
          writeFile: async (path: string, content: string) => {
            try {
              const response = await fetch(`${baseUrl}/write?path=${encodeURIComponent(path)}`, {
                method: 'POST',
                body: content,
                headers
              });
              if (response.status === 401) { api.log("Bridge Error: Unauthorized (Invalid Key)"); throw new Error("Unauthorized"); }
              if (!response.ok) throw new Error(await response.text());
            } catch (err: any) {
              api.log('BridgeFS writeFile error: ' + err.message);
              throw err;
            }
          },
          listDirectory: async (path: string) => {
            try {
              const response = await fetch(`${baseUrl}/ls?path=${encodeURIComponent(path)}`, { headers });
              if (response.status === 401) { api.log("Bridge Error: Unauthorized (Invalid Key)"); return []; }
              if (!response.ok) throw new Error(await response.text());
              return await response.json();
            } catch (err: any) {
              api.log('BridgeFS listDirectory error: ' + err.message);
              return [];
            }
          },
          isDirectory: async (path: string) => {
            try {
              const response = await fetch(`${baseUrl}/is_dir?path=${encodeURIComponent(path)}`, { headers });
              if (response.status === 401) { api.log("Bridge Error: Unauthorized (Invalid Key)"); return false; }
              if (!response.ok) throw new Error(await response.text());
              const data = await response.json();
              return data.is_dir;
            } catch (err: any) {
              api.log('BridgeFS isDirectory error: ' + err.message);
              return false;
            }
          }
        };

        api.setFS(bridgeFS);
        api.log(`Connected to Bridge at ${baseUrl} with key protection`);
        api.executeCommand("e .");
        return;
      }

      try {
        // @ts-ignore
        const handle = await window.showDirectoryPicker({
          mode: "readwrite"
        });
        
        // @ts-ignore
        if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
          // @ts-ignore
          await handle.requestPermission({ mode: "readwrite" });
        }

        const fs = createExternalFS(handle);
        api.setFS(fs);
        api.log("Mounted external folder");
        api.executeCommand("e ."); // Refresh explorer to root
      } catch (err: any) {
        api.log("Failed to mount folder: " + err.message);
      }
    });
    
    api.log("External-FS plugin ready. Use :ed to mount a folder.");
  }
};

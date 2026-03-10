
// @ts-nocheck
export default {
  metadata: {
    name: 'ts-lsp',
    description: 'TypeScript LSP for Web-Vim'
  },
  setup: async (api: any) => {
    try {
      api.log('TS-LSP: Loading Comlink...');
      const Comlink = await import("https://esm.sh/comlink@4.4.1");
      api.log('TS-LSP: Comlink loaded. Loading worker source...');
      
      const workerSource = await api.configFs.readFile(".config/web-vim/prelude/ts-lsp-worker.ts");
      if (!workerSource) {
        api.log("TS-LSP Error: Could not find worker source");
        return;
      }
      
      const blob = new Blob([workerSource], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      api.log('TS-LSP: Spawning worker...');
      
      const workerInstance = new Worker(workerUrl, { type: 'module' });
      workerInstance.onerror = (e: any) => api.log('TS-LSP Worker Error: ' + (e.message || 'Check console'));
      
      const worker = Comlink.wrap(workerInstance);
      
      api.log('TS-LSP: Testing connection (ping)...');
      const pong = await worker.ping();
      api.log('TS-LSP: Connection ok: ' + pong);
      
      api.log('TS-LSP: Calling worker.initialize()...');
      await worker.initialize();
      api.log('TS-LSP: Worker initialized successfully');

      let lints: any[] = [];
      let currentPath = '';
      const indexedPackages = new Set<string>();
      const indexedFiles = new Set<string>();
      const failedLookups = new Set<string>();

      // Global semaphore for all indexing tasks
      let activeFetches = 0;
      const MAX_CONCURRENT_FETCHES = 10;
      const waitForSlot = async () => {
        while (activeFetches >= MAX_CONCURRENT_FETCHES) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };

      const pathJoin = (...parts: string[]) => {
        const joined = parts.join('/').split('/');
        const result: string[] = [];
        const isAbsolute = parts[0]?.startsWith('/') || false;
        for (const part of joined) {
          if (part === '..') result.pop();
          else if (part !== '.' && part !== '') result.push(part);
        }
        return (isAbsolute ? '/' : '') + result.join('/');
      };

      const indexFile = async (fullPath: string) => {
        if (indexedFiles.has(fullPath) || failedLookups.has(fullPath)) return;

        const fs = api.getFS();
        
        await waitForSlot();
        activeFetches++;
        let content;
        try {
          content = await fs.readFile(fullPath);
        } finally {
          activeFetches--;
        }

        if (content === null) {
          failedLookups.add(fullPath);
          return;
        }

        indexedFiles.add(fullPath);
        const absolutePath = fullPath.startsWith('/') ? fullPath : '/' + fullPath;
        await worker.updateFile(absolutePath, content);
        
        // Log sparingly
        if (indexedFiles.size % 20 === 0) api.log(`TS-LSP: Indexed ${indexedFiles.size} files...`);

        try {
          const imports = await worker.getImportedModules(absolutePath, content);
          const dir = fullPath.split('/').slice(0, -1).join('/');

          const tasks = imports.map(async (imp) => {
            if (imp.startsWith('.')) {
              // Relative import
              const resolvedPath = pathJoin(dir, imp);
              const possiblePaths = [
                resolvedPath,
                resolvedPath + '.d.ts',
                resolvedPath.replace(/\.js$/, '.d.ts'),
                resolvedPath.replace(/\.ts$/, '.d.ts'),
                resolvedPath + '/index.d.ts',
                resolvedPath + '.ts',
                resolvedPath + '.tsx'
              ];
              for (const p of possiblePaths) {
                if (failedLookups.has(p)) continue;
                if (indexedFiles.has(p)) break;

                // Try reading directly to check existence
                await waitForSlot();
                activeFetches++;
                let c;
                try {
                  c = await fs.readFile(p);
                } finally {
                  activeFetches--;
                }

                if (c !== null) {
                  await indexFile(p);
                  break;
                } else {
                  failedLookups.add(p);
                }
              }
            } else if (!imp.startsWith('/')) {
              // Package import
              await indexPackageTypes(imp);
            }
          });
          await Promise.all(tasks);
        } catch (e) {}
      };

      const indexPackageTypes = async (pkgName: string) => {
        // Handle sub-packages (e.g., solid-js/web -> solid-js)
        const parts = pkgName.split('/');
        const basePkgName = pkgName.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
        
        if (indexedPackages.has(basePkgName)) return;
        indexedPackages.add(basePkgName);

        const fs = api.getFS();
        
        const tryPackage = async (name: string) => {
          try {
            const pkgJsonPath = `node_modules/${name}/package.json`;
            if (failedLookups.has(pkgJsonPath)) return false;

            await waitForSlot();
            activeFetches++;
            let pkgJsonStr;
            try {
              pkgJsonStr = await fs.readFile(pkgJsonPath);
            } finally {
              activeFetches--;
            }

            if (!pkgJsonStr) {
              failedLookups.add(pkgJsonPath);
              return false;
            }
            
            // Critical: Index package.json in the worker for resolution!
            await worker.updateFile('/' + pkgJsonPath, pkgJsonStr);
            
            const pkgJson = JSON.parse(pkgJsonStr);
            let typesPath = pkgJson.types || pkgJson.typings;
            
            if (!typesPath) {
              const possiblePaths = [
                `node_modules/${name}/index.d.ts`,
                `node_modules/${name}/dist/index.d.ts`,
                `node_modules/${name}/types.d.ts`,
              ];
              for (const p of possiblePaths) {
                if (failedLookups.has(p)) continue;
                
                await waitForSlot();
                activeFetches++;
                let content;
                try {
                  content = await fs.readFile(p);
                } finally {
                  activeFetches--;
                }

                if (content !== null) {
                  typesPath = p.replace(`node_modules/${name}/`, '');
                  break;
                } else {
                  failedLookups.add(p);
                }
              }
            }
            
            if (typesPath) {
              const fullTypesPath = `node_modules/${name}/${typesPath}`;
              await indexFile(fullTypesPath);
              
              // Special case for solid-js to ensure JSX types are loaded
              if (name === 'solid-js') {
                await indexFile('node_modules/solid-js/types/jsx.d.ts');
                // Also index sub-packages that are common
                await indexFile('node_modules/solid-js/web/types/index.d.ts');
              }
              return true;
            }
          } catch (e) {}
          return false;
        };

        if (await tryPackage(basePkgName)) return;
        await tryPackage(`@types/${basePkgName}`);
      };

      const resolveImports = async (fullPath: string, content: string) => {
        try {
          const absolutePath = fullPath.startsWith('/') ? fullPath : '/' + fullPath;
          const imports = await worker.getImportedModules(absolutePath, content);
          const dir = fullPath.split('/').slice(0, -1).join('/');

          const tasks = imports.map(async (imp) => {
            if (imp.startsWith('.')) {
              // Relative import
              const resolvedPath = pathJoin(dir, imp);
              const possiblePaths = [
                resolvedPath,
                resolvedPath + '.d.ts',
                resolvedPath.replace(/\.js$/, '.d.ts'),
                resolvedPath.replace(/\.ts$/, '.d.ts'),
                resolvedPath + '/index.d.ts',
                resolvedPath + '.ts',
                resolvedPath + '.tsx'
              ];
              for (const p of possiblePaths) {
                if (failedLookups.has(p)) continue;
                if (indexedFiles.has(p)) break;

                await waitForSlot();
                activeFetches++;
                let c;
                try {
                  c = await api.getFS().readFile(p);
                } finally {
                  activeFetches--;
                }

                if (c !== null) {
                  await indexFile(p);
                  break;
                } else {
                  failedLookups.add(p);
                }
              }
            } else if (!imp.startsWith('/')) {
              // Package import
              await indexPackageTypes(imp);
            }
          });
          await Promise.all(tasks);
        } catch (e) {}
      };

      const updateLints = async () => {
        if (!currentPath) return;
        const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
        lints = await worker.getLints(absolutePath);
        if (lints.length > 0) {
          api.log(`TS-LSP: Found ${lints.length} lints for ${absolutePath}`);
        }
      };

      const getLintsForLine = (lineIdx: number) => {
        const buffer = api.getBuffer();
        let lineStart = 0;
        for (let i = 0; i < lineIdx; i++) lineStart += (buffer[i]?.length || 0) + 1;
        const lineEnd = lineStart + (buffer[lineIdx]?.length || 0);
        return lints.filter(l => {
          const lFrom = l.from ?? 0;
          const lTo = l.to ?? lFrom;
          // Check for overlap: [lFrom, lTo] intersects [lineStart, lineEnd]
          return lFrom <= lineEnd && lTo >= lineStart;
        });
      };

      api.registerCommand('showDiagnostics', () => {
        const cursor = api.getCursor();
        const lineLints = getLintsForLine(cursor.y);
        if (lineLints.length > 0) {
          const messages = lineLints.map((l: any) => l.message).join('\n');
          api.showHover(messages, cursor.x, cursor.y);
          setTimeout(() => api.hideHover(), 5000);
        }
      });

      api.registerCommand('nextDiagnostic', () => {
        const cursor = api.getCursor();
        const buffer = api.getBuffer();
        let currentPos = 0;
        for (let i = 0; i < cursor.y; i++) currentPos += (buffer[i]?.length || 0) + 1;
        currentPos += cursor.x;

        const next = lints.find(l => l.from > currentPos && l.category === 1);
        if (next) {
          let pos = 0;
          for (let i = 0; i < buffer.length; i++) {
            const lineLen = (buffer[i]?.length || 0) + 1;
            if (pos + lineLen > next.from) {
              api.setCursor(next.from - pos, i);
              return;
            }
            pos += lineLen;
          }
        }
      });

      api.registerCommand('prevDiagnostic', () => {
        const cursor = api.getCursor();
        const buffer = api.getBuffer();
        let currentPos = 0;
        for (let i = 0; i < cursor.y; i++) currentPos += (buffer[i]?.length || 0) + 1;
        currentPos += cursor.x;

        const prev = [...lints].reverse().find(l => l.from < currentPos && l.category === 1);
        if (prev) {
          let pos = 0;
          for (let i = 0; i < buffer.length; i++) {
            const lineLen = (buffer[i]?.length || 0) + 1;
            if (pos + lineLen > prev.from) {
              api.setCursor(prev.from - pos, i);
              return;
            }
            pos += lineLen;
          }
        }
      });

      let isSyncing = false;
      const syncFileSystem = async () => {
        if (isSyncing) {
          api.log('TS-LSP: Sync already in progress...');
          return;
        }
        isSyncing = true;
        api.log('TS-LSP: Syncing file system...');
        const fs = api.getFS();
        let count = 0;
        const CONCURRENCY_LIMIT = 5;
        let activeTasks = 0;
        const startTime = Date.now();

        const walk = async (path: string) => {
          // Skip common large/irrelevant directories
          if (path.includes('.git') || path.includes('dist') || path.includes('build') || path.includes('.next') || path.includes('node_modules')) return;
          
          try {
            const entries = await fs.listDirectory(path);
            for (const entry of entries) {
              const isDir = entry.endsWith('/');
              const name = isDir ? entry.slice(0, -1) : entry;
              const fullPath = path ? (path.endsWith('/') ? path + name : path + '/' + name) : name;
              
              if (isDir) {
                await walk(fullPath);
              } else {
                const isTS = fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') || fullPath.endsWith('.d.ts');
                const isJS = fullPath.endsWith('.js') || fullPath.endsWith('.jsx');
                const isConfig = fullPath.endsWith('package.json') || fullPath.endsWith('tsconfig.json');
                
                if (isTS || isJS || isConfig) {
                  while (activeTasks >= CONCURRENCY_LIMIT) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                  }
                  activeTasks++;
                  (async () => {
                    try {
                      const content = await fs.readFile(fullPath);
                      if (content !== null) {
                        const absolutePath = fullPath.startsWith('/') ? fullPath : '/' + fullPath;
                        await worker.updateFile(absolutePath, content);
                        count++;
                        if (count % 50 === 0) api.log(`TS-LSP: Indexed ${count} files...`);
                      }
                    } catch (e) {
                    } finally {
                      activeTasks--;
                    }
                  })();
                }
              }
            }
          } catch (e: any) {
            api.log('TS-LSP: Walk error at ' + path + ': ' + e.message);
          }
        };

        try {
          await walk('');
          while (activeTasks > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          api.log(`TS-LSP: Sync complete. Indexed ${count} files in ${duration}s.`);
        } catch (err: any) {
          api.log('TS-LSP: Sync failed: ' + err.message);
        } finally {
          isSyncing = false;
        }
      };

      // Initial sync and sync on FS change
      syncFileSystem();
      api.on('FSChanged', () => {
        syncFileSystem();
      });

      api.on('BufferLoaded', async (data: any) => {
        currentPath = data.path;
        if (currentPath.endsWith('.ts') || currentPath.endsWith('.tsx')) {
          const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
          await worker.updateFile(absolutePath, data.content);
          await resolveImports(absolutePath, data.content);
          await updateLints();
        }
      });
      
      api.registerCommand('TSSync', () => {
        syncFileSystem();
      });
      
      let debounceTimer: any = null;

      const triggerCompletions = async () => {
        if (api.getMode() !== 'Insert') return;
        const cursor = api.getCursor();
        const bufferLines = api.getBuffer();
        let pos = 0;
        for (let i = 0; i < cursor.y; i++) {
          pos += bufferLines[i].length + 1;
        }
        pos += cursor.x;
        
        const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
        const completions = await worker.getCompletions(absolutePath, pos);
        if (completions && completions.length > 0) {
          api.showCompletions(completions, (item: any) => {
            const currentBuffer = api.getBuffer();
            const line = currentBuffer[cursor.y];
            const newLine = line.slice(0, cursor.x) + item.label + line.slice(cursor.x);
            currentBuffer[cursor.y] = newLine;
            api.setBuffer(currentBuffer);
            api.setCursor(cursor.x + item.label.length, cursor.y);
          });
        } else {
          api.hideCompletions();
        }
      };

      api.on('KeyDown', async (data: any) => {
        if (data.key === ' ' && data.ctrl) {
          await triggerCompletions();
        }
      });

      api.on('TextChanged', async () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        
        debounceTimer = setTimeout(async () => {
          const buffer = api.getBuffer().join('\n');
          if (currentPath && (currentPath.endsWith('.ts') || currentPath.endsWith('.tsx'))) {
            const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
            await worker.updateFile(absolutePath, buffer);
            await resolveImports(absolutePath, buffer);
            await updateLints();
            
            if (api.getMode() === 'Insert') {
              const cursor = api.getCursor();
              const bufferLines = api.getBuffer();
              const line = bufferLines[cursor.y];
              if (line && line[cursor.x - 1] === '.') {
                await triggerCompletions();
              } else {
                api.hideCompletions();
              }
            }
          }
        }, 300);
      });
            api.registerGutter({
        name: 'ts-lint',
        width: 2,
        priority: 50,
        render: ({ lineIndex }: any) => {
          const idx = typeof lineIndex === 'function' ? lineIndex() : lineIndex;
          const lineLints = getLintsForLine(idx);
          const hasError = lineLints.some((l: any) => l.category === 1);

          return (
            <tui-text content={hasError ? ' E' : '  '} color="#ff0000" />
          );
        }
      });

      api.registerCommand('hover', async () => {
        if (!currentPath) return;
        const cursor = api.getCursor();
        const bufferLines = api.getBuffer();
        let pos = 0;
        for (let i = 0; i < cursor.y; i++) {
          pos += bufferLines[i].length + 1;
        }
        pos += cursor.x;
        
        const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
        const hover = await worker.getHover(absolutePath, pos);
        if (hover) {
          api.showHover(hover.display, cursor.x, cursor.y);
          setTimeout(() => api.hideHover(), 3000);
        }
      });

      api.registerLineRenderer({
        name: 'ts-highlighter',
        priority: 10,
        render: ({ lineIndex, lineContent, leftCol, viewportWidth }: any) => {
          const content = typeof lineContent === 'function' ? lineContent() : lineContent;
          const startCol = typeof leftCol === 'function' ? leftCol() : leftCol;
          const width = typeof viewportWidth === 'function' ? viewportWidth() : viewportWidth;
          
          if (!currentPath || !(currentPath.endsWith('.ts') || currentPath.endsWith('.tsx'))) {
            return <tui-text content={content.slice(startCol, startCol + width)} />;
          }
          
          const keywords = ['import', 'export', 'default', 'const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'await', 'async'];
          const parts = [];
          const words = content.split(/(\W+)/);
          let currentX = 0;
          for (const word of words) {
            if (word.length > 0) {
              const wordEnd = currentX + word.length;
              if (wordEnd > startCol && currentX < startCol + width) {
                const isKeyword = keywords.includes(word);
                const renderStart = Math.max(0, startCol - currentX);
                const renderEnd = Math.min(word.length, startCol + width - currentX);
                const visibleText = word.slice(renderStart, renderEnd);
                const visualX = Math.max(0, currentX - startCol);
                parts.push(<tui-text x={visualX} y={0} content={visibleText} color={isKeyword ? '#569cd6' : '#ffffff'} />);
              }
              currentX += word.length;
            }
          }
          
          return parts;
        }
      });
    } catch (err: any) {
      api.log('TS-LSP Setup Error: ' + err.message);
    }
  }
};

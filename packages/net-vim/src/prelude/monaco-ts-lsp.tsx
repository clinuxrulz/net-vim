
// @ts-nocheck
export default {
  metadata: {
    name: 'monaco-ts-lsp',
    description: 'TypeScript LSP powered by Monaco editor instance'
  },
  setup: async (api: any) => {
    let monaco: any = null;
    let isInitialized = false;
    let currentPath = '';
    let lints: any[] = [];
    let classificationsMap = new Map<string, any>();
    let debounceTimer: any = null;
    let modelsMap = new Map<string, any>();
    let extraLibsSet = new Set<string>();

    // Monaco TS-LSP plugin loaded (lazy - waits for activation command)

    const ensureMonaco = async () => {
      if (isInitialized) return true;
      
      if (typeof window === 'undefined' || !window.monaco) {
        return false;
      }

      monaco = window.monaco;
      isInitialized = true;
      return true;
    };

    const getFileUri = (absolutePath: string) => {
      const normalizedPath = absolutePath.startsWith('/') ? absolutePath.slice(1) : absolutePath;
      return `file:///${normalizedPath}`;
    };

    const getOrCreateModel = (absolutePath: string, content: string) => {
      const uri = monaco.Uri.parse(getFileUri(absolutePath));
      let model = monaco.editor.getModel(uri);
      if (!model) {
        model = monaco.editor.createModel(content, 'typescript', uri);
        modelsMap.set(absolutePath, model);
      } else {
        model.setValue(content);
        model.setLanguage('typescript');
      }
      return model;
    };

    const getTypeScriptWorker = async (absolutePath: string) => {
      const buffer = api.getBuffer().join('\n');
      getOrCreateModel(absolutePath, buffer);
      const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
      const worker = await getWorker(monaco.Uri.parse(getFileUri(absolutePath)));
      return worker;
    };

    const addFileToProject = async (absolutePath: string, content: string) => {
      try {
        const defaults = monaco.languages.typescript.typescriptDefaults;
        
        defaults.setCompilerOptions({
          ...defaults.getCompilerOptions(),
          allowJs: true,
          checkJs: true,
          allowNonTsExtensions: true,
          target: monaco.languages.typescript.ScriptTarget.ES2020,
          module: monaco.languages.typescript.ModuleKind.ESNext,
          moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        });
        
        const uri = getFileUri(absolutePath);
        if (!extraLibsSet.has(uri)) {
          defaults.addExtraLib(content, uri);
          extraLibsSet.add(uri);
        }
        
        return true;
      } catch (e) {
        return false;
      }
    };

    const getColorForClassification = (type: string) => {
      const colorMap: Record<string, string> = {
        'comment': '#6a9955',
        'comment.ts': '#6a9955',
        'keyword': '#569cd6',
        'keyword.ts': '#569cd6',
        'keyword.control': '#569cd6',
        'keyword.control.ts': '#569cd6',
        'keyword.operator': '#d4d4d4',
        'keyword.operator.ts': '#d4d4d4',
        'number': '#b5cea8',
        'number.ts': '#b5cea8',
        'string': '#ce9178',
        'string.ts': '#ce9178',
        'string.js': '#ce9178',
        'regexp': '#d16969',
        'regexp.ts': '#d16969',
        'operator': '#d4d4d4',
        'operator.ts': '#d4d4d4',
        'delimiter': '#d4d4d4',
        'delimiter.ts': '#d4d4d4',
        'delimiter.bracket': '#d4d4d4',
        'delimiter.bracket.ts': '#d4d4d4',
        'delimiter.parenthesis': '#d4d4d4',
        'delimiter.parenthesis.ts': '#d4d4d4',
        'delimiter.square': '#d4d4d4',
        'delimiter.square.ts': '#d4d4d4',
        'identifier': '#9cdcfe',
        'identifier.ts': '#9cdcfe',
        'type': '#4ec9b0',
        'type.ts': '#4ec9b0',
        'type.identifier': '#4ec9b0',
        'type.identifier.ts': '#4ec9b0',
        'class': '#4ec9b0',
        'class.ts': '#4ec9b0',
        'interface': '#4ec9b0',
        'interface.ts': '#4ec9b0',
        'enum': '#4ec9b0',
        'enum.ts': '#4ec9b0',
        'function': '#dcdcaa',
        'function.ts': '#dcdcaa',
        'method': '#dcdcaa',
        'method.ts': '#dcdcaa',
        'variable': '#9cdcfe',
        'variable.ts': '#9cdcfe',
        'variable.predefined': '#569cd6',
        'variable.predefined.ts': '#569cd6',
        'parameter': '#9cdcfe',
        'parameter.ts': '#9cdcfe',
        'property': '#9cdcfe',
        'property.ts': '#9cdcfe',
        'constant': '#4fc1ff',
        'constant.ts': '#4fc1ff',
        'event': '#ff9791',
        'event.ts': '#ff9791',
        'tag': '#569cd6',
        'tag.ts': '#569cd6',
        'attribute.name': '#9cdcfe',
        'attribute.name.ts': '#9cdcfe',
        'attribute.value': '#ce9178',
        'attribute.value.ts': '#ce9178',
        'metatag': '#c586c0',
        'metatag.ts': '#c586c0',
        'annotation': '#dcdcaa',
        'annotation.ts': '#dcdcaa',
      };
      return colorMap[type] || '#dcdcaa';
    };

    const updateDiagnostics = async (absolutePath: string) => {
      if (!monaco) return;
      
      try {
        const fileUri = getFileUri(absolutePath);
        const worker = await getTypeScriptWorker(absolutePath);
        
        const semantic = await worker.getSemanticDiagnostics(fileUri);
        const syntactic = await worker.getSyntacticDiagnostics(fileUri);
        
        lints = [];
        
        const processDiags = (diagnostics: any[], category: number) => {
          for (const diag of diagnostics) {
            if (diag.start !== undefined && diag.length !== undefined) {
              const message = typeof diag.messageText === 'string' 
                ? diag.messageText 
                : (diag.messageText?.messageText || String(diag.messageText || diag));
                
              lints.push({
                from: diag.start,
                to: diag.start + diag.length,
                message: message,
                category
              });
            }
          }
        };
        
        processDiags(syntactic || [], 1);
        processDiags(semantic || [], 1);
        
        api.rerender();
      } catch (err: any) {
        console.error('Monaco-TS-LSP Diagnostics:', err);
      }
    };

    const getCompletions = async (absolutePath: string, position: number) => {
      if (!monaco) return [];
      
      try {
        const fileUri = getFileUri(absolutePath);
        const worker = await getTypeScriptWorker(absolutePath);
        const completions = await worker.getCompletionsAtPosition(fileUri, position);
        
        if (!completions) return [];
        
        return completions.entries.map((item: any) => ({
          label: item.name,
          kind: item.kind,
          detail: item.kindModifiers,
          documentation: item.documentation?.map((d: any) => d.text).join(''),
          insertText: item.insertText || item.name,
        }));
      } catch (err: any) {
        console.error('Monaco-TS-LSP Completions:', err);
        return [];
      }
    };

    const getHover = async (absolutePath: string, position: number) => {
      if (!monaco) return null;
      
      try {
        const fileUri = getFileUri(absolutePath);
        const worker = await getTypeScriptWorker(absolutePath);
        const hover = await worker.getQuickInfoAtPosition(fileUri, position);
        
        if (hover && hover.textSpan) {
          const displayParts = hover.displayParts || [];
          const docs = hover.documentation || [];
          return {
            display: [...displayParts, ...docs].map((d: any) => d.text).join(''),
            range: {
              start: hover.textSpan.start,
              end: hover.textSpan.start + hover.textSpan.length
            }
          };
        }
        return null;
      } catch (err: any) {
        console.error('Monaco-TS-LSP Hover:', err);
        return null;
      }
    };

    const getDefinition = async (absolutePath: string, position: number) => {
      if (!monaco) return null;
      
      try {
        const fileUri = getFileUri(absolutePath);
        const worker = await getTypeScriptWorker(absolutePath);
        const definitions = await worker.getDefinitionAtPosition(fileUri, position);
        
        if (definitions && definitions.length > 0) {
          const def = definitions[0];
          return {
            uri: def.file,
            range: def
          };
        }
        return null;
      } catch (err: any) {
        return null;
      }
    };

    const getClassifications = async (absolutePath: string) => {
      if (!monaco) return null;
      
      try {
        const buffer = api.getBuffer().join('\n');
        const bufferLines = api.getBuffer();
        getOrCreateModel(absolutePath, buffer);
        
        const tokens = monaco.editor.tokenize(buffer, 'typescript');
        if (!tokens || !Array.isArray(tokens)) return null;
        
        const result: any[] = [];
        let lineOffset = 0;
        
        for (let lineIdx = 0; lineIdx < tokens.length; lineIdx++) {
          const lineTokens = tokens[lineIdx];
          const lineLength = (bufferLines[lineIdx]?.length || 0);
          
          if (!lineTokens || lineTokens.length === 0) {
            lineOffset += lineLength + 1;
            continue;
          }
          
          for (let i = 0; i < lineTokens.length; i++) {
            const token = lineTokens[i];
            const offset = token.startIndex ?? token.offset ?? 0;
            const nextToken = lineTokens[i + 1];
            const nextOffset = nextToken ? (nextToken.startIndex ?? nextToken.offset ?? 0) : lineLength;
            const length = nextOffset - offset;
            
            result.push({
              start: lineOffset + offset,
              length: length,
              type: token.type
            });
          }
          lineOffset += lineLength + 1;
        }
        
        return result;
      } catch (err: any) {
        return null;
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
        return lFrom <= lineEnd && lTo >= lineStart;
      });
    };

    let originalCompletions: any[] = [];
    let completionTriggerPos: { x: number, y: number } | null = null;

    const showFilteredCompletions = () => {
      if (!completionTriggerPos) return;
      const cursor = api.getCursor();
      if (cursor.y !== completionTriggerPos.y || cursor.x < completionTriggerPos.x) {
        api.hideCompletions();
        originalCompletions = [];
        completionTriggerPos = null;
        return;
      }

      const line = api.getBuffer()[cursor.y];
      const filterText = line.slice(completionTriggerPos.x, cursor.x).toLowerCase();
      
      const filtered = originalCompletions.filter(item => 
        item.label.toLowerCase().includes(filterText)
      );

      if (filtered.length > 0) {
        api.showCompletions(filtered, (item: any) => {
          const currentBuffer = api.getBuffer();
          const currentLine = currentBuffer[cursor.y];
          const newLine = currentLine.slice(0, completionTriggerPos.x) + item.label + currentLine.slice(cursor.x);
          currentBuffer[cursor.y] = newLine;
          api.setBuffer(currentBuffer);
          api.setCursor(completionTriggerPos.x + item.label.length, cursor.y);
          
          originalCompletions = [];
          completionTriggerPos = null;
        });
      } else {
        api.hideCompletions();
      }
    };

    const triggerCompletions = async () => {
      if (api.getMode() !== 'Insert' || !currentPath) return;
      
      const cursor = api.getCursor();
      const bufferLines = api.getBuffer();
      const line = bufferLines[cursor.y] || "";
      
      let triggerX = cursor.x;
      if (line[cursor.x - 1] === '.') {
        triggerX = cursor.x;
      } else {
        while (triggerX > 0 && /[a-zA-Z0-9_$]/.test(line[triggerX - 1])) {
          triggerX--;
        }
      }

      let pos = 0;
      for (let i = 0; i < cursor.y; i++) {
        pos += bufferLines[i].length + 1;
      }
      pos += triggerX;
      
      const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
      const completions = await getCompletions(absolutePath, pos);
      
      if (completions && completions.length > 0) {
        originalCompletions = completions;
        completionTriggerPos = { x: triggerX, y: cursor.y };
        showFilteredCompletions();
      }
    };

    const updateClassifications = async () => {
      if (!currentPath || !currentPath.match(/\.(ts|tsx|js|jsx)$/)) return;
      const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
      
      try {
        const classifications = await getClassifications(absolutePath);
        if (classifications && classifications.length > 0) {
          classificationsMap.set(absolutePath, classifications);
          api.rerender();
        }
      } catch (e) {
        console.error('Monaco-TS-LSP Classification:', e);
      }
    };

    api.registerCommand('MonacoTSStart', async () => {
      if (await ensureMonaco()) {
        const currentFile = api.getCurrentFilePath();
        if (currentFile && currentFile.match(/\.(ts|tsx|js|jsx)$/)) {
          currentPath = currentFile;
          const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
          await updateDiagnostics(absolutePath);
          await updateClassifications();
        }
      }
    });

    api.registerCommand('MonacoTSStop', () => {
      isInitialized = false;
      monaco = null;
      lints = [];
      classificationsMap.clear();
      for (const model of modelsMap.values()) {
        model.dispose();
      }
      modelsMap.clear();
      extraLibsSet.clear();
      api.log('Monaco-TS-LSP: Deactivated');
    });

    api.registerCommand('hover', async () => {
      if (!isInitialized || !currentPath) return;
      
      const cursor = api.getCursor();
      const bufferLines = api.getBuffer();
      let pos = 0;
      for (let i = 0; i < cursor.y; i++) {
        pos += bufferLines[i].length + 1;
      }
      pos += cursor.x;
      
      const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
      const hover = await getHover(absolutePath, pos);
      
      if (hover) {
        api.showHover(hover.display, cursor.x, cursor.y);
        setTimeout(() => api.hideHover(), 3000);
      }
    });

    api.registerCommand('MonacoTSHover', () => api.executeCommand('hover'));

    api.registerCommand('definition', async () => {
      if (!isInitialized || !currentPath) return;
      
      const cursor = api.getCursor();
      const bufferLines = api.getBuffer();
      let pos = 0;
      for (let i = 0; i < cursor.y; i++) {
        pos += bufferLines[i].length + 1;
      }
      pos += cursor.x;
      
      const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
      const definition = await getDefinition(absolutePath, pos);
      
      if (definition && definition.uri) {
        api.log(`Monaco-TS-LSP: Definition at ${definition.uri}`);
      }
    });

    api.registerCommand('MonacoTSDefinition', () => api.executeCommand('definition'));

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

    api.registerGutter({
      name: 'monaco-ts-lint',
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

    api.on('BufferLoaded', async (data: any) => {
      if (!isInitialized) return;
      
      currentPath = data.path;
      if (currentPath.match(/\.(ts|tsx|js|jsx)$/)) {
        const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
        await updateDiagnostics(absolutePath);
        await updateClassifications();
      }
    });

    api.on('TextChanged', () => {
      if (!isInitialized || !currentPath) return;
      
      if (debounceTimer) clearTimeout(debounceTimer);
      
      debounceTimer = setTimeout(async () => {
        const absolutePath = currentPath.startsWith('/') ? currentPath : '/' + currentPath;
        await updateDiagnostics(absolutePath);
        await updateClassifications();
        
        if (api.getMode() === 'Insert') {
          const cursor = api.getCursor();
          const bufferLines = api.getBuffer();
          const line = bufferLines[cursor.y];
          if (line && line[cursor.x - 1] === '.') {
            await triggerCompletions();
          } else if (completionTriggerPos) {
            showFilteredCompletions();
          }
        }
      }, 300);
    });

    api.on('KeyDown', async (data: any) => {
      if (!isInitialized) return;
      
      if (data.key === ' ' && data.ctrl) {
        await triggerCompletions();
      }
      if (data.key === 'Escape') {
        originalCompletions = [];
        completionTriggerPos = null;
        api.hideCompletions();
      }
    });

    api.registerLineRenderer({
      name: 'monaco-ts-highlighter',
      priority: 10,
      render: ({ lineIndex, lineContent, leftCol, viewportWidth, visualStart, mode, cursor, currentFilePath }: any) => {
        if (!isInitialized) return null;
        
        const path = typeof currentFilePath === 'function' ? currentFilePath() : currentFilePath;
        if (!path || !path.match(/\.(ts|tsx|js|jsx)$/)) return null;

        const content = typeof lineContent === 'function' ? lineContent() : lineContent;
        const startCol = typeof leftCol === 'function' ? leftCol() : leftCol;
        const width = typeof viewportWidth === 'function' ? viewportWidth() : viewportWidth;
        const idx = typeof lineIndex === 'function' ? lineIndex() : lineIndex;

        const visualStartVal = typeof visualStart === 'function' ? visualStart() : visualStart;
        const currentMode = typeof mode === 'function' ? mode() : mode;
        const currentCursor = typeof cursor === 'function' ? cursor() : cursor;

        let highlightStart = -1;
        let highlightEnd = -1;

        if (visualStartVal && currentMode === 'Visual') {
          let s = visualStartVal;
          let e = currentCursor;
          if (s.y > e.y || (s.y === e.y && s.x > e.x)) {
            [s, e] = [e, s];
          }

          if (idx >= s.y && idx <= e.y) {
            highlightStart = (idx === s.y) ? s.x : 0;
            highlightEnd = (idx === e.y) ? e.x : content.length;
            highlightEnd = Math.min(content.length, highlightEnd + 1);
          }
        }

        const getRawTokens = () => {
          const absolutePath = path.startsWith('/') ? path : '/' + path;
          const classifications = classificationsMap.get(absolutePath);
          if (!classifications) {
            return [{ x: 0, content: content.slice(startCol, startCol + width), color: '#dcdcaa' }];
          }

          const bufferLines = api.getBuffer();
          let lineStartOffset = 0;
          for (let i = 0; i < idx; i++) {
            lineStartOffset += (bufferLines[i]?.length || 0) + 1;
          }
          const lineEndOffset = lineStartOffset + content.length;

          const relevantSpans = classifications.filter((span: any) => 
            span.start + (span.length || 0) > lineStartOffset && span.start < lineEndOffset
          );

          const tokens = [];
          let currentPos = lineStartOffset;
          const visibleEndCol = startCol + width;

          for (const span of relevantSpans) {
            if (span.start < currentPos) continue;

            if (span.start > currentPos) {
              const gapStart = Math.max(startCol, currentPos - lineStartOffset);
              const gapEnd = Math.min(visibleEndCol, span.start - lineStartOffset);
              if (gapEnd > gapStart) {
                tokens.push({
                  x: gapStart - startCol,
                  content: content.slice(gapStart, gapEnd),
                  color: '#ffffff'
                });
              }
            }

            const spanStart = Math.max(startCol, span.start - lineStartOffset);
            const spanEnd = Math.min(visibleEndCol, span.start + span.length - lineStartOffset);
            if (spanEnd > spanStart) {
              const color = getColorForClassification(span.type);
              tokens.push({
                x: spanStart - startCol,
                content: content.slice(spanStart, spanEnd),
                color
              });
            }
            currentPos = span.start + span.length;
          }

          if (currentPos < lineEndOffset) {
            const gapStart = Math.max(startCol, currentPos - lineStartOffset);
            const gapEnd = Math.min(visibleEndCol, content.length);
            if (gapEnd > gapStart) {
              tokens.push({
                x: gapStart - startCol,
                content: content.slice(gapStart, gapEnd),
                color: '#ffffff'
              });
            }
          }
          return tokens;
        };

        const rawTokens = getRawTokens();
        const finalTokens = [];

        for (const t of rawTokens) {
          const tokenStart = t.x + startCol;
          const tokenEnd = tokenStart + t.content.length;

          if (highlightStart === -1 || tokenEnd <= highlightStart || tokenStart >= highlightEnd) {
            finalTokens.push(t);
          } else {
            const splitPoints = [highlightStart, highlightEnd].filter(p => p > tokenStart && p < tokenEnd);
            let lastP = tokenStart;
            for (const p of [...splitPoints, tokenEnd]) {
              const partContent = t.content.slice(lastP - tokenStart, p - tokenStart);
              if (partContent.length > 0) {
                const isHighlighted = lastP >= highlightStart && lastP < highlightEnd;
                finalTokens.push({
                  x: lastP - startCol,
                  content: partContent,
                  color: t.color,
                  bg_color: isHighlighted ? "#004b72" : undefined
                });
              }
              lastP = p;
            }
          }
        }
        
        return finalTokens.map(t => (
          <tui-text 
            x={t.x} 
            y={0} 
            content={t.content} 
            color={t.color} 
            bg_color={t.bg_color} 
          />
        ));
      }
    });
  }
};

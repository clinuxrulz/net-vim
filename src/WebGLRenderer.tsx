import { onMount, createEffect, onCleanup } from 'solid-js';

interface WebGLRendererProps {
  chars: Uint8Array;
  fgs: Uint8Array;
  bgs: Uint8Array;
  width: number;
  height: number;
  cursorX: number;
  cursorY: number;
  crtEnabled?: boolean;
  showKeyboard?: boolean;
  onMeasure?: (size: { width: number, height: number }) => void;
}

export const WebGLRenderer = (props: WebGLRendererProps & { canvasRef?: (el: HTMLCanvasElement) => void }) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let fontTexture: WebGLTexture | null = null;
  let charsTexture: WebGLTexture | null = null;
  let fgsTexture: WebGLTexture | null = null;
  let bgsTexture: WebGLTexture | null = null;
  let startTime: number; // Declare startTime here
  let animationFrameId: number | null = null;

  const FONT_STYLE = 'bold 24px monospace';

  const measureFont = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = FONT_STYLE;
    let maxWidth = 0;
    // Sweep over printable ASCII to find max width
    for (let i = 32; i < 127; i++) {
      const metrics = ctx.measureText(String.fromCharCode(i));
      if (metrics.width > maxWidth) {
        maxWidth = metrics.width;
      }
    }
    // Add small padding (e.g., 2px total, 1px on each side)
    const cellWidth = Math.ceil(maxWidth) + 2;
    const cellHeight = 32; // We'll keep a fixed height for the atlas rows
    return { cellWidth, cellHeight };
  };

  const { cellWidth, cellHeight } = measureFont();

  const vertexShaderSource = `#version 300 es
    in vec2 position;
    out vec2 vUv;
    void main() {
      vUv = position * 0.5 + 0.5;
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;

  const fragmentShaderSource = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 fragColor;

    uniform sampler2D fontTex;
    uniform sampler2D charsTex;
    uniform sampler2D fgsTex;
    uniform sampler2D bgsTex;
    uniform vec2 gridRes;
    uniform vec2 cursorPos; // New: x, y in grid coordinates
    uniform float time; // New: for animation
    uniform float curveIntensity; // New: for curve
    uniform float scanlineIntensity; // New: for scanlines
    uniform float tearIntensity; // New: for screen tearing

    // Function to apply a subtle curve distortion
    vec2 curve(vec2 uv) {
        uv = uv * 2.0 - 1.0; // scale from [0,1] to [-1,1]
        // Apply a quadratic distortion, more pronounced towards edges
        uv.x *= 1.0 + curveIntensity * (uv.y * uv.y);
        uv.y *= 1.0 + curveIntensity * (uv.x * uv.x);
        return uv * 0.5 + 0.5; // scale back to [0,1]
    }

    void main() {
      vec2 uv = vUv;

      // Animated Screen Tearing effect
      // This effect displaces scanlines horizontally based on time and y-position
      float tearOffset = 0.0;
      float tearFrequency = 50.0; // How many tears along the y-axis
      float tearSpeed = 10.0; // How fast the tears animate
      float tearWave = sin(uv.y * tearFrequency + time * tearSpeed) * cos(uv.y * tearFrequency * 0.5 + time * tearSpeed * 0.7);
      
      // Apply tearing only to certain bands or at certain times for a more dynamic effect
      // The 'mod' function creates bands where the tearing is visible
      if (mod(floor(uv.y * gridRes.y + time * 0.5), 10.0) < 2.0) { // Affects certain horizontal bands
        tearOffset = tearWave * 0.01 * tearIntensity; // Scale by tear intensity
      }
      uv.x += tearOffset; // Apply horizontal displacement

      // Apply curvature to the UVs
      uv = curve(uv);

      // Ensure UVs remain within [0,1] after distortion and tearing,
      // otherwise, texture sampling might result in undefined behavior
      uv = clamp(uv, 0.0, 1.0);

      // TUI grid: (0,0) is top-left.
      // vUv: (0,0) is bottom-left.
      vec2 tuiUv = vec2(uv.x, 1.0 - uv.y);
      
      // Calculate cell coordinates and local coordinates within the cell
      vec2 cellCoord = floor(tuiUv * gridRes);
      vec2 localCoord = fract(tuiUv * gridRes);
      
      // Sample character index, foreground, and background colors from textures
      float charIdx = texture(charsTex, (cellCoord + 0.5) / gridRes).r * 255.0;
      vec3 fg = texture(fgsTex, (cellCoord + 0.5) / gridRes).rgb;
      vec3 bg = texture(bgsTex, (cellCoord + 0.5) / gridRes).rgb;

      // Font Atlas (16x16 grid).
      // Row 0 (char 0-15) is at the TOP of the texture (Y=1.0) due to UNPACK_FLIP_Y_WEBGL.
      float row = floor(charIdx / 16.0);
      float col = mod(charIdx, 16.0);
      
      // Adjust localCoord.y for font texture sampling (0 at top of cell -> 1 at top)
      vec2 fontUv = (vec2(col, 15.0 - row) + vec2(localCoord.x, 1.0 - localCoord.y)) / 16.0;
      
      // Sample font texture and mix foreground/background colors
      float fontSample = texture(fontTex, fontUv).r;

      // Handle Cursor: blinking underscore effect
      // Check if this cell matches the cursor position
      if (floor(cellCoord.x + 0.5) == floor(cursorPos.x + 0.5) && 
          floor(cellCoord.y + 0.5) == floor(cursorPos.y + 0.5)) {
          // Blinking effect: toggle every 500ms
          if (mod(time, 1.0) < 0.5) {
              // Draw underscore at the bottom of the cell (localCoord.y is 0 at top, 1 at bottom for tuiUv logic?)
              // Wait, let's re-examine: tuiUv = vec2(uv.x, 1.0 - uv.y);
              // localCoord = fract(tuiUv * gridRes);
              // localCoord.y = 0 at the top of the cell, 1 at the bottom.
              if (localCoord.y > 0.875) {
                  // Force foreground color for the underscore
                  fontSample = 1.0;
              }
          }
      }

      vec3 finalColor = mix(bg, fg, fontSample);

      // Scanline effect: Darken every other scanline
      // gl_FragCoord.y provides the pixel's y-coordinate on the screen
      if (mod(floor(gl_FragCoord.y), 2.0) < 1.0) { // Every other line
          finalColor *= (1.0 - scanlineIntensity); // Reduce brightness
      }

      fragColor = vec4(finalColor, 1.0);
    }
  `;

  const initGL = () => {
    if (!canvasRef) return;
    gl = canvasRef.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) return;

    const createShader = (gl: WebGL2RenderingContext, type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };

    const vs = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    // Font Atlas
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    fontTexture = createFontAtlas(gl);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    
    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    
    const posLoc = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    charsTexture = gl.createTexture()!;
    fgsTexture = gl.createTexture()!;
    bgsTexture = gl.createTexture()!;

    [charsTexture, fgsTexture, bgsTexture].forEach(tex => {
      gl!.bindTexture(gl!.TEXTURE_2D, tex);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    });
  };

  function isPrintableASCII(c: string) {
    // Matches characters in the range from space (ASCII 32) to tilde (ASCII 126)
    return /^[ -~]$/.test(c);
  }

  const BOX_CHARS: Record<number, string> = {
    1: '│',
    2: '─',
    3: '┌',
    4: '┐',
    5: '└',
    6: '┘',
    7: '├',
    8: '┤',
    9: '┬',
    10: '┴',
    11: '┼',
    12: '╭',
    13: '╮',
    14: '╯',
    15: '╰',
  };

  const createFontAtlas = (gl: WebGL2RenderingContext) => {
    const canvas = document.createElement('canvas');
    const atlasWidth = cellWidth * 16;
    const atlasHeight = cellHeight * 16;
    canvas.width = atlasWidth;
    canvas.height = atlasHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, atlasWidth, atlasHeight);
    ctx.fillStyle = 'white';
    ctx.font = FONT_STYLE;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < 256; i++) {
      let char = '';
      if (isPrintableASCII(String.fromCharCode(i))) {
        char = String.fromCharCode(i);
      } else if (BOX_CHARS[i]) {
        char = BOX_CHARS[i];
      } else {
        continue;
      }
      const x = (i % 16) * cellWidth + cellWidth / 2;
      const y = Math.floor(i / 16) * cellHeight + cellHeight / 2;
      ctx.fillText(char, x, y);
    }

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlasWidth, atlasHeight, 0, gl.RED, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  };

  const updateTextures = () => {
    if (!gl) return;
    
    gl.bindTexture(gl.TEXTURE_2D, charsTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, props.width, props.height, 0, gl.RED, gl.UNSIGNED_BYTE, props.chars);

    gl.bindTexture(gl.TEXTURE_2D, fgsTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, props.width, props.height, 0, gl.RGB, gl.UNSIGNED_BYTE, props.fgs);

    gl.bindTexture(gl.TEXTURE_2D, bgsTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, props.width, props.height, 0, gl.RGB, gl.UNSIGNED_BYTE, props.bgs);
  };

  const renderFrame = () => {
    animationFrameId = null;
    if (!gl || !program || !canvasRef) return;
    
    try {
      // Resize canvas to match display size
      const displayWidth = canvasRef.clientWidth;
      const displayHeight = canvasRef.clientHeight;
      if (canvasRef.width !== displayWidth || canvasRef.height !== displayHeight) {
        canvasRef.width = displayWidth;
        canvasRef.height = displayHeight;
      }

      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      gl.useProgram(program);
      
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fontTexture);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, charsTexture);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, fgsTexture);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, bgsTexture);

      gl.uniform1i(gl.getUniformLocation(program, 'fontTex'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'charsTex'), 1);
      gl.uniform1i(gl.getUniformLocation(program, 'fgsTex'), 2);
      gl.uniform1i(gl.getUniformLocation(program, 'bgsTex'), 3);
      gl.uniform2f(gl.getUniformLocation(program, 'gridRes'), props.width, props.height);
      gl.uniform2f(gl.getUniformLocation(program, 'cursorPos'), props.cursorX, props.cursorY);

      // Get elapsed time for animations
      const currentTime = performance.now();
      const elapsedTime = (currentTime - startTime) / 1000.0; // convert to seconds
      gl.uniform1f(gl.getUniformLocation(program, 'time'), elapsedTime);

      // Set retro effect intensities
      const intensities = props.crtEnabled ? {
        curve: 0.05,
        scanline: 0.3,
        tear: 1.0
      } : {
        curve: 0.0,
        scanline: 0.0,
        tear: 0.0
      };

      gl.uniform1f(gl.getUniformLocation(program, 'curveIntensity'), intensities.curve); // Adjust as needed, e.g., 0.05 to 0.2
      gl.uniform1f(gl.getUniformLocation(program, 'scanlineIntensity'), intensities.scanline); // Adjust as needed, e.g., 0.1 to 0.5
      gl.uniform1f(gl.getUniformLocation(program, 'tearIntensity'), intensities.tear); // Adjust as needed, e.g., 0.5 to 2.0

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } finally {
      if (props.crtEnabled) {
        animationFrameId = requestAnimationFrame(renderFrame);
      }
    }
  };

  const requestRender = () => {
    if (animationFrameId === null) {
      animationFrameId = requestAnimationFrame(renderFrame);
    }
  };

  onMount(() => {
    initGL();
    if (props.onMeasure) {
      props.onMeasure({ width: cellWidth, height: cellHeight });
    }
    startTime = performance.now(); // Initialize startTime here
    requestRender();
    
    window.addEventListener('resize', requestRender);
    onCleanup(() => {
      window.removeEventListener('resize', requestRender);
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
    });
  });

  createEffect(() => {
    // React to all rendering-relevant props
    const _ = {
      chars: props.chars,
      fgs: props.fgs,
      bgs: props.bgs,
      width: props.width,
      height: props.height,
      cursorX: props.cursorX,
      cursorY: props.cursorY,
      crtEnabled: props.crtEnabled,
      showKeyboard: props.showKeyboard
    };
    
    updateTextures();
    requestRender();
  });

  // Blink timer for non-CRT mode
  createEffect(() => {
    if (!props.crtEnabled) {
      const interval = setInterval(() => {
        requestRender();
      }, 500);
      onCleanup(() => clearInterval(interval));
    }
  });

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', border: 'none' }} />;
};

# Plan: Switch from xterm.js to ghostty-web

## Context

The terminal component uses `@xterm/xterm` (v6) with `@xterm/addon-fit`. ghostty-web (v0.4.0, by Coder) is an xterm.js replacement using Ghostty's Zig parser compiled to WASM.

**Verified from actual type definitions (npm package inspected):**
- `Terminal` class: `open()`, `dispose()`, `write()`, `writeln()`, `focus()`, `blur()`, `resize()`, `loadAddon()` - all present
- `onData: IEvent<string>` - same signature as xterm.js (callback returns IDisposable)
- `onResize: IEvent<{cols, rows}>` - same
- `cols`/`rows` properties - present
- `ITerminalOptions`: `cursorBlink`, `fontSize`, `fontFamily`, `theme` - all present
- `ITheme`: `background`, `foreground`, `cursor`, `selectionBackground` - all present
- `FitAddon` ships built-in with `fit()`, `proposeDimensions()`, `dispose()` - no external addon needed
- `init(): Promise<void>` exported - must be called before creating Terminal (loads WASM)
- **Missing from xterm.js:** `letterSpacing` option (we set it to 0, so no-op - safe to drop)

**Honest caveat:** Pre-1.0 (v0.4.0). Not battle-tested like xterm.js. But the API surface we use is small and fully supported.

## Files to modify

1. **`frontend/package.json`** - Swap dependencies
2. **`frontend/src/components/Terminal/Terminal.jsx`** - Update imports, add WASM init
3. **`frontend/src/components/Terminal/Terminal.module.css`** - Remove xterm CSS reference (if needed)

No backend changes - terminal emulation is purely frontend.

## Steps

### 1. Swap dependencies

```
pnpm remove @xterm/xterm @xterm/addon-fit --filter claude-patrol-frontend
pnpm add ghostty-web --filter claude-patrol-frontend
```

### 2. Update Terminal.jsx

Changes to `frontend/src/components/Terminal/Terminal.jsx`:

**Imports** - replace:
```jsx
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
```
with:
```jsx
import { init, Terminal as GhosttyTerminal, FitAddon } from 'ghostty-web';
```

**WASM init** - the `useEffect` must become async-aware since `init()` returns a Promise. Use a cancellation flag pattern:

```jsx
useEffect(() => {
  if (!containerRef.current || !wsUrl) return;

  let cancelled = false;
  let term, ws, observer;

  init().then(() => {
    if (cancelled) return;

    term = new GhosttyTerminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      // letterSpacing: removed (not supported, was 0 anyway)
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    term.focus();

    termRef.current = term;
    fitRef.current = fitAddon;

    // ... WebSocket setup identical to current code ...
    // ... ResizeObserver setup identical ...
  });

  return () => {
    cancelled = true;
    observer?.disconnect();
    ws?.close();
    term?.dispose();
  };
}, [wsUrl]);
```

Key difference from current code: everything after `init()` is inside a `.then()` callback, and cleanup handles the case where init hasn't resolved yet (`term?.dispose()`).

### 3. Vite WASM handling

ghostty-web ships a `ghostty-vt.wasm` file. Vite 7 should handle this, but if bundling issues arise, add to `frontend/vite.config.js`:
```js
optimizeDeps: { exclude: ['ghostty-web'] }
```

### 4. CSS cleanup

Remove the `import '@xterm/xterm/css/xterm.css'` line. ghostty-web renders to a `<canvas>` element and doesn't need xterm's CSS. The existing `.terminal` CSS class (dark background) still applies to the container.

## Verification

1. `pnpm build` in `frontend/` - no build errors
2. `node src/index.js --no-open` - start server
3. Open browser, toggle terminal drawer
4. Verify: terminal renders, shell prompt appears, typing works, output displays correctly
5. Resize the drawer - terminal re-fits
6. Kill and recreate session - lifecycle works
7. Take screenshot for build log

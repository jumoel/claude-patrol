import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from './Terminal.jsx';

const state = vi.hoisted(() => ({
  constructedTerminals: 0,
  disposedTerminals: 0,
  fitCalls: 0,
  refreshCalls: 0,
  clearTextureAtlasCalls: 0,
  bounds: { width: 800, height: 400 },
  keyHandler: /** @type {((event: KeyboardEvent) => boolean) | null} */ (null),
  resizeCallback: /** @type {(() => void) | null} */ (null),
  sockets: /** @type {FakeWebSocket[]} */ ([]),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = { disableStdin: false };
    rows = 24;
    cols = 80;
    textarea = null;

    constructor() {
      state.constructedTerminals++;
    }

    loadAddon() {}
    open() {}
    focus() {}
    onData() {}
    write() {}
    clearTextureAtlas() {
      state.clearTextureAtlasCalls++;
    }
    refresh() {
      state.refreshCalls++;
    }

    /** @param {(event: KeyboardEvent) => boolean} handler */
    attachCustomKeyEventHandler(handler) {
      state.keyHandler = handler;
    }

    dispose() {
      state.disposedTerminals++;
    }
  },
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      state.fitCalls++;
    }
  },
}));

vi.mock('@xterm/addon-unicode-graphemes', () => ({
  UnicodeGraphemesAddon: class {},
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

class FakeResizeObserver {
  /** @param {() => void} callback */
  constructor(callback) {
    state.resizeCallback = callback;
  }

  observe() {}
  disconnect() {}
}

class FakeWebSocket {
  static OPEN = 1;

  /** @param {string | URL} url */
  constructor(url) {
    this.url = url.toString();
    this.readyState = FakeWebSocket.OPEN;
    this.onopen = /** @type {((event: Event) => void) | null} */ (null);
    this.onmessage = /** @type {((event: {data: string}) => void) | null} */ (null);
    this.onclose = /** @type {((event: {code: number}) => void) | null} */ (null);
    this.sent = /** @type {string[]} */ ([]);
    this.close = vi.fn(() => {
      this.readyState = 3;
    });
    state.sockets.push(this);
  }

  /** @param {string} data */
  send(data) {
    this.sent.push(data);
  }
}

describe('Terminal connection lifecycle', () => {
  beforeEach(() => {
    state.constructedTerminals = 0;
    state.disposedTerminals = 0;
    state.fitCalls = 0;
    state.refreshCalls = 0;
    state.clearTextureAtlasCalls = 0;
    state.bounds = { width: 800, height: 400 };
    state.keyHandler = null;
    state.resizeCallback = null;
    state.sockets = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        /** @type {DOMRect} */ ({
          ...state.bounds,
          x: 0,
          y: 0,
          top: 0,
          right: state.bounds.width,
          bottom: state.bounds.height,
          left: 0,
          toJSON: () => ({}),
        }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('updates callbacks and the exposed socket ref without reconnecting', async () => {
    const firstExit = vi.fn();
    const nextExit = vi.fn();
    const firstToggle = vi.fn();
    const nextToggle = vi.fn();
    const firstWsRef = /** @type {{current: WebSocket | null}} */ ({ current: null });
    const nextWsRef = /** @type {{current: WebSocket | null}} */ ({ current: null });

    const view = render(
      <Terminal wsUrl="/ws/sessions/one" wsRef={firstWsRef} onExit={firstExit} onToggleMaximize={firstToggle} />,
    );

    await waitFor(() => expect(state.sockets).toHaveLength(1));
    const socket = state.sockets[0];
    expect(firstWsRef.current).toBe(socket);

    view.rerender(
      <Terminal wsUrl="/ws/sessions/one" wsRef={nextWsRef} onExit={nextExit} onToggleMaximize={nextToggle} />,
    );

    await waitFor(() => expect(nextWsRef.current).toBe(socket));
    expect(firstWsRef.current).toBeNull();
    expect(state.constructedTerminals).toBe(1);
    expect(state.disposedTerminals).toBe(0);
    expect(state.sockets).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();

    state.keyHandler?.(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    socket.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 9 }) });

    expect(firstToggle).not.toHaveBeenCalled();
    expect(nextToggle).toHaveBeenCalledOnce();
    expect(firstExit).not.toHaveBeenCalled();
    expect(nextExit).toHaveBeenCalledWith(9);
  });

  it('reconnects when the WebSocket URL changes', async () => {
    const view = render(<Terminal wsUrl="/ws/sessions/one" />);
    await waitFor(() => expect(state.sockets).toHaveLength(1));

    const firstSocket = state.sockets[0];
    view.rerender(<Terminal wsUrl="/ws/sessions/two" />);

    await waitFor(() => expect(state.sockets).toHaveLength(2));
    expect(firstSocket.close).toHaveBeenCalledOnce();
    expect(state.constructedTerminals).toBe(2);
    expect(state.disposedTerminals).toBe(1);
  });

  it('refits and redraws after its container changes size', async () => {
    render(<Terminal wsUrl="/ws/sessions/one" />);
    await waitFor(() => expect(state.sockets).toHaveLength(1));

    const fitsBeforeResize = state.fitCalls;
    state.resizeCallback?.();

    await waitFor(() => expect(state.fitCalls).toBeGreaterThan(fitsBeforeResize));
    expect(state.clearTextureAtlasCalls).toBeGreaterThan(0);
    expect(state.refreshCalls).toBeGreaterThan(0);
    expect(state.sockets[0].sent).toContain(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  });

  it('waits for a hidden terminal to become visible before fitting it', async () => {
    state.bounds = { width: 0, height: 0 };
    render(<Terminal wsUrl="/ws/sessions/one" />);
    await waitFor(() => expect(state.sockets).toHaveLength(1));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(state.fitCalls).toBe(0);
    expect(state.clearTextureAtlasCalls).toBe(0);

    state.bounds = { width: 800, height: 400 };
    state.resizeCallback?.();

    await waitFor(() => expect(state.fitCalls).toBeGreaterThan(0));
    expect(state.clearTextureAtlasCalls).toBeGreaterThan(0);
  });
});

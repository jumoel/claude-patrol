/** One EventSource connection shared by every data hook in a browser tab. */
export class EventStreamHub {
  /** @param {(url: string) => EventSource} [createSource] */
  constructor(createSource = (url) => new EventSource(url)) {
    this.createSource = createSource;
    /** @type {EventSource | null} */
    this.source = null;
    /** @type {Map<string, Set<(event: MessageEvent<string>) => void>>} */
    this.listeners = new Map();
    /** @type {Map<string, (event: MessageEvent<string>) => void>} */
    this.forwarders = new Map();
  }

  /**
   * @param {string} type
   * @param {(event: MessageEvent<string>) => void} listener
   */
  subscribe(type, listener) {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
    this.ensureSource();
    this.ensureForwarder(type);

    return () => {
      const current = this.listeners.get(type);
      current?.delete(listener);
      if (current?.size === 0) {
        this.listeners.delete(type);
        const forwarder = this.forwarders.get(type);
        if (forwarder && this.source) this.source.removeEventListener(type, forwarder);
        this.forwarders.delete(type);
      }
      if (this.listeners.size === 0) this.close();
    };
  }

  ensureSource() {
    if (this.source) return;
    this.source = this.createSource('/api/events');
    for (const type of this.listeners.keys()) this.ensureForwarder(type);
  }

  /** @param {string} type */
  ensureForwarder(type) {
    if (!this.source || this.forwarders.has(type)) return;
    /** @param {MessageEvent<string>} event */
    const forwarder = (event) => {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    };
    this.forwarders.set(type, forwarder);
    this.source.addEventListener(type, forwarder);
  }

  close() {
    this.source?.close();
    this.source = null;
    this.forwarders.clear();
  }
}

const appEventStream = new EventStreamHub();

/**
 * @param {string} type
 * @param {(event: MessageEvent<string>) => void} listener
 */
export function subscribeAppEvent(type, listener) {
  return appEventStream.subscribe(type, listener);
}

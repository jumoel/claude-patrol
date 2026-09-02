/**
 * Terminal output buffering for PTY sessions: a replay ring buffer and a
 * per-tick batcher for WebSocket frames. Pure data structures, no I/O.
 */

/**
 * Fixed-size circular buffer. Appends copy only the new bytes; linearization
 * happens on the much less frequent replay path.
 */
export class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('RingBuffer capacity must be a positive integer');
    }
    this.buf = Buffer.alloc(capacity);
    this.start = 0;
    this.len = 0;
  }

  append(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (chunk.length >= this.buf.length) {
      // Data larger than buffer - keep only the tail
      chunk.copy(this.buf, 0, chunk.length - this.buf.length);
      this.start = 0;
      this.len = this.buf.length;
      return;
    }

    const overflow = Math.max(0, this.len + chunk.length - this.buf.length);
    this.start = (this.start + overflow) % this.buf.length;
    this.len -= overflow;

    const writeStart = (this.start + this.len) % this.buf.length;
    const firstLength = Math.min(chunk.length, this.buf.length - writeStart);
    chunk.copy(this.buf, writeStart, 0, firstLength);
    if (firstLength < chunk.length) {
      chunk.copy(this.buf, 0, firstLength);
    }
    this.len += chunk.length;
  }

  contents() {
    if (this.len === 0) return this.buf.subarray(0, 0);
    const end = this.start + this.len;
    if (end <= this.buf.length) return this.buf.subarray(this.start, end);

    const result = Buffer.allocUnsafe(this.len);
    const firstLength = this.buf.length - this.start;
    this.buf.copy(result, 0, this.start);
    this.buf.copy(result, firstLength, 0, end - this.buf.length);
    return result;
  }
}

/**
 * Coalesce the small PTY reads emitted in one event-loop turn into one output
 * frame. The replay buffer remains authoritative while no browser is attached.
 */
export class TerminalOutputBatcher {
  constructor(websockets, schedule = setImmediate, cancel = clearImmediate) {
    this.websockets = websockets;
    this.schedule = schedule;
    this.cancel = cancel;
    this.pendingChunks = [];
    this.flushHandle = null;
  }

  append(data) {
    if (!this.hasOpenSocket()) return;
    this.pendingChunks.push(data);
    if (this.flushHandle !== null) return;
    this.flushHandle = this.schedule(() => {
      this.flushHandle = null;
      this.flush();
    });
  }

  flush() {
    if (this.flushHandle !== null) {
      this.cancel(this.flushHandle);
      this.flushHandle = null;
    }
    if (this.pendingChunks.length === 0) return;

    const data = this.pendingChunks.join('');
    this.pendingChunks.length = 0;
    if (!this.hasOpenSocket()) return;

    const msg = JSON.stringify({ type: 'output', data });
    for (const ws of this.websockets) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  hasOpenSocket() {
    for (const ws of this.websockets) {
      if (ws.readyState === 1) return true;
    }
    return false;
  }
}

/** Bytes of scrollback kept per session for replay to a newly attached browser. */
export const BUFFER_MAX = 50_000;

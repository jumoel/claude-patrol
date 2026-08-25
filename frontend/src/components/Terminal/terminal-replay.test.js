import { describe, expect, it, vi } from 'vitest';
import { writeTerminalReplay } from './terminal-replay.js';

describe('writeTerminalReplay', () => {
  it('suppresses terminal replies until replay parsing completes', () => {
    /** @type {(() => void) | undefined} */
    let finishWrite;
    let disableStdinDuringWrite;
    const onComplete = vi.fn();
    const term = {
      options: { disableStdin: false },
      /** @param {string} _data @param {() => void} callback */
      write(_data, callback) {
        disableStdinDuringWrite = this.options.disableStdin;
        finishWrite = callback;
      },
    };

    writeTerminalReplay(term, '\x1b[>c', onComplete);

    expect(disableStdinDuringWrite).toBe(true);
    expect(term.options.disableStdin).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();

    finishWrite?.();

    expect(term.options.disableStdin).toBe(false);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

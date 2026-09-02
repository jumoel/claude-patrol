/**
 * Graceful-shutdown state machine for the server process.
 *
 * States: running -> prompting -> exiting. A signal with no live sessions, in
 * --clean mode, or SIGTERM exits at once. Otherwise an interactive prompt asks
 * whether to kill or preserve sessions; a second signal while prompting
 * preserves and exits; a signal while exiting force-quits.
 *
 * @param {{
 *   activeSessionCount: () => number,
 *   exit: (killSessions: boolean) => Promise<void>,
 *   forceExit: () => void,
 *   isClean: boolean,
 *   isTTY: boolean,
 *   stdin: NodeJS.ReadStream,
 *   destroyTui: () => void,
 *   log: (line: string) => void,
 * }} deps
 */
export function createShutdownController(deps) {
  let state = 'running';

  const exit = (killSessions) => {
    state = 'exiting';
    return deps.exit(killSessions);
  };

  const onKey = (key) => {
    deps.stdin.removeListener('data', onKey);
    if (key === '\x03') return exit(false);
    return exit(key.trim().toLowerCase() === 'k');
  };

  return {
    get state() {
      return state;
    },
    /** @param {'SIGINT'|'SIGTERM'} signal */
    shutdown(signal) {
      if (state === 'exiting') return deps.forceExit();
      if (state === 'prompting') return exit(false);

      const count = deps.activeSessionCount();
      if (count === 0 || deps.isClean || signal === 'SIGTERM') return exit(deps.isClean);

      state = 'prompting';
      deps.destroyTui();
      deps.log(`\n${count} active session(s) running.`);
      deps.log('  [k] Kill sessions and exit');
      deps.log('  [Enter/p] Preserve sessions and exit (reattach on next start)');
      deps.log('  [Ctrl-C] Preserve and exit immediately');

      // Re-enable raw mode so single keypresses are delivered immediately.
      if (deps.isTTY && !deps.stdin.isRaw) deps.stdin.setRawMode(true);
      deps.stdin.resume();
      deps.stdin.on('data', onKey);
      return undefined;
    },
  };
}

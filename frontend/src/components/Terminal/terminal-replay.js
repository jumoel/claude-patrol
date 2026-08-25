/**
 * @param {{
 *   options: { disableStdin?: boolean },
 *   write: (data: string, callback: () => void) => void,
 * }} term
 * @param {string} data
 * @param {() => void} onComplete
 */
export function writeTerminalReplay(term, data, onComplete) {
  const disableStdin = term.options.disableStdin;
  term.options.disableStdin = true;
  term.write(data, () => {
    term.options.disableStdin = disableStdin;
    onComplete();
  });
}

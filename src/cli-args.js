/**
 * Command-line flags for the server process. Parsed once at startup so the
 * rest of index.js works from a plain options object instead of scanning
 * process.argv in several places.
 * @typedef {{ port: number | null, host: string | null, reattach: boolean, clean: boolean, open: boolean, noOpen: boolean }} CliOptions
 */

/**
 * @param {string[]} argv arguments after the script path
 * @param {{ open?: boolean, noOpen?: boolean, reattach?: boolean, clean?: boolean }} [overrides] programmatic options that win over flags
 * @returns {CliOptions}
 */
export function parseCliOptions(argv, overrides = {}) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  const portValue = valueAfter('--port');
  const port = portValue === null ? null : Number(portValue);
  if (argv.includes('--port') && (portValue === null || !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new RangeError(`--port must be an integer between 1 and 65535, got ${JSON.stringify(portValue)}`);
  }
  const host = valueAfter('--host');
  if (argv.includes('--host') && !host) throw new RangeError('--host requires a value');
  return {
    port,
    host,
    reattach: Boolean(overrides.reattach) || argv.includes('--reattach'),
    clean: Boolean(overrides.clean) || argv.includes('--clean'),
    open: Boolean(overrides.open) || argv.includes('--open'),
    noOpen: Boolean(overrides.noOpen),
  };
}

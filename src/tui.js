/**
 * Minimal TUI for the claude-patrol server terminal.
 *
 * Renders a bordered log panel that fills the terminal height, with a
 * persistent header and footer. New log lines scroll inside the panel.
 * All output is timestamped. The footer shows a status/keybinding hint.
 *
 * Box-drawing uses Unicode light box characters:
 *   ┌─┐ │ │ └─┘
 */

const BOX = { tl: '\u250c', tr: '\u2510', bl: '\u2514', br: '\u2518', h: '\u2500', v: '\u2502' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

/** @type {{ msg: string, level: string, ts: Date }[]} */
let logBuffer = [];
let headerText = '';
let footerText = '';
let active = false;

/** Original console methods, saved before patching. */
let origLog, origWarn, origError;

function cols() {
  return process.stdout.columns || 80;
}

function rows() {
  return process.stdout.rows || 24;
}

/** Format a timestamp as HH:MM:SS. */
function ts(date) {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * Strip ANSI escape codes for length calculation.
 * @param {string} s
 */
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Truncate a string (by visible length) to fit a width, adding ellipsis.
 * @param {string} s
 * @param {number} max
 */
function truncate(s, max) {
  const visible = stripAnsi(s);
  if (visible.length <= max) return s;
  // Naive truncation - works for simple cases. For strings with ANSI codes
  // in the middle this won't be pixel-perfect, but it's good enough for logs.
  return s.slice(0, max - 1) + '\u2026';
}

/**
 * Pad/truncate a string to exactly `width` visible characters.
 * @param {string} s
 * @param {number} width
 */
function fitToWidth(s, width) {
  const visible = stripAnsi(s);
  if (visible.length > width) return truncate(s, width);
  return s + ' '.repeat(width - visible.length);
}

/** Full redraw of the TUI. */
function render() {
  if (!active) return;
  const w = cols();
  const h = rows();

  // Layout: 1 header line, 1 top border, (h-4) log lines, 1 bottom border, 1 footer line
  const logAreaHeight = Math.max(1, h - 4);
  const innerWidth = w - 2; // inside the box (excluding the two │ chars)

  // Hide cursor and move to top-left
  process.stdout.write('\x1b[?25l\x1b[H');

  // Header line
  const header = fitToWidth(` ${BOLD}claude-patrol${RESET}  ${DIM}${headerText}${RESET}`, w);
  process.stdout.write(`${header}\n`);

  // Top border
  process.stdout.write(`${DIM}${BOX.tl}${BOX.h.repeat(w - 2)}${BOX.tr}${RESET}\n`);

  // Log lines - show the most recent entries that fit
  const visibleLogs = logBuffer.slice(-logAreaHeight);
  for (let i = 0; i < logAreaHeight; i++) {
    const entry = visibleLogs[i];
    if (entry) {
      const timestamp = `${DIM}${ts(entry.ts)}${RESET} `;
      const levelPrefix = entry.level === 'error' ? `${RED}ERR${RESET} ` :
                          entry.level === 'warn' ? `${YELLOW}WRN${RESET} ` : '';
      const line = `${timestamp}${levelPrefix}${entry.msg}`;
      const fitted = fitToWidth(line, innerWidth);
      process.stdout.write(`${DIM}${BOX.v}${RESET}${fitted}${DIM}${BOX.v}${RESET}\n`);
    } else {
      process.stdout.write(`${DIM}${BOX.v}${RESET}${' '.repeat(innerWidth)}${DIM}${BOX.v}${RESET}\n`);
    }
  }

  // Bottom border
  process.stdout.write(`${DIM}${BOX.bl}${BOX.h.repeat(w - 2)}${BOX.br}${RESET}\n`);

  // Footer line
  const footer = fitToWidth(` ${footerText}`, w);
  process.stdout.write(footer);

  // Clear anything below (in case terminal shrank)
  process.stdout.write('\x1b[J');
}

/**
 * Add a log entry and re-render.
 * @param {string} msg
 * @param {'log' | 'warn' | 'error'} level
 */
function addLog(msg, level = 'log') {
  // Strip the [claude-patrol] prefix since the TUI already identifies the app
  const cleaned = msg.replace(/^\[claude-patrol\]\s*/, '');
  logBuffer.push({ msg: cleaned, level, ts: new Date() });

  // Cap buffer at 1000 entries
  if (logBuffer.length > 1000) logBuffer = logBuffer.slice(-500);

  render();
}

/**
 * Initialize the TUI, patching console methods and setting up resize handling.
 * @param {{ header?: string, footer?: string }} options
 */
export function initTui({ header = '', footer = '' } = {}) {
  headerText = header;
  footerText = footer;
  active = true;

  // Clear screen and set up alternate screen buffer would be nice, but
  // we keep the main buffer so scrollback works after exit.
  process.stdout.write('\x1b[2J\x1b[H');

  // Save originals
  origLog = console.log.bind(console);
  origWarn = console.warn.bind(console);
  origError = console.error.bind(console);

  // Patch console methods to route through TUI
  console.log = (...args) => addLog(formatArgs(args), 'log');
  console.warn = (...args) => addLog(formatArgs(args), 'warn');
  console.error = (...args) => addLog(formatArgs(args), 'error');

  // Redraw on terminal resize
  process.stdout.on('resize', render);

  render();
}

/** Update the header text and re-render. */
export function setHeader(text) {
  headerText = text;
  render();
}

/** Update the footer text and re-render. */
export function setFooter(text) {
  footerText = text;
  render();
}

/** Tear down the TUI, restoring console methods. */
export function destroyTui() {
  if (!active) return;
  active = false;
  process.stdout.removeListener('resize', render);
  // Show cursor
  process.stdout.write('\x1b[?25h');
  // Restore console
  if (origLog) console.log = origLog;
  if (origWarn) console.warn = origWarn;
  if (origError) console.error = origError;
}

/**
 * Format console.log-style arguments into a single string.
 * @param {any[]} args
 */
function formatArgs(args) {
  return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
}

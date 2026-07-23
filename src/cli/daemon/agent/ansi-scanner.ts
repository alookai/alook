/**
 * ANSI terminal query responder for Ink-based TUI applications.
 *
 * When Claude Code starts, Ink sends DA1/DA2/DSR/XTVERSION queries to detect
 * terminal capabilities. If these are not answered, the TUI hangs indefinitely.
 * This scanner detects those queries in PTY output and writes appropriate responses.
 */

export interface TerminalWriter {
  write(data: string): void;
}

/**
 * Scans PTY output for terminal capability queries and responds to them.
 * Returns true if any query was detected and responded to.
 */
export function handleTerminalQueries(
  data: string,
  terminal: TerminalWriter,
): boolean {
  let handled = false;

  // DA1 — Primary Device Attributes: \x1b[c or \x1b[0c
  // Respond as xterm-compatible terminal
  if (/\x1b\[(?:0)?c/.test(data)) {
    terminal.write("\x1b[?62;22c");
    handled = true;
  }

  // DA2 — Secondary Device Attributes: \x1b[>c or \x1b[>0c
  // Respond with xterm version
  if (/\x1b\[>(?:0)?c/.test(data)) {
    terminal.write("\x1b[>41;0;0c");
    handled = true;
  }

  // DSR — Device Status Report / Cursor Position: \x1b[6n
  // Respond with cursor at row 1, col 1
  if (/\x1b\[6n/.test(data)) {
    terminal.write("\x1b[1;1R");
    handled = true;
  }

  // XTVERSION — Terminal version query: \x1b[>0q or \x1b[>q
  if (/\x1b\[>(?:0)?q/.test(data)) {
    terminal.write("\x1bP>|xterm(388)\x1b\\");
    handled = true;
  }

  // Window size query (DTTERM): \x1b[18t
  if (/\x1b\[18t/.test(data)) {
    terminal.write("\x1b[8;24;80t");
    handled = true;
  }

  return handled;
}

/**
 * Strip ANSI escape sequences from terminal output for text inspection.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07]*\x07|\].*?\x1b\\|\[[\?\>\=]?[0-9;]*[a-zA-Z])/g, "");
}

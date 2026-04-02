/**
 * Logger — all output goes to stderr so it never corrupts the stdio MCP stream.
 */

const DEBUG_ENABLED =
  process.env.DEBUG === "mcp-connector" ||
  process.env.DEBUG === "*" ||
  process.env.DEBUG === "true";

const PREFIX = "[mcp-connector]";

function write(level: string, args: unknown[]): void {
  const msg = args
    .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
    .join(" ");
  process.stderr.write(`${PREFIX} ${level}: ${msg}\n`);
}

export const log = {
  info: (...args: unknown[]): void => write("INFO ", args),
  warn: (...args: unknown[]): void => write("WARN ", args),
  error: (...args: unknown[]): void => write("ERROR", args),
  debug: (...args: unknown[]): void => {
    if (DEBUG_ENABLED) write("DEBUG", args);
  },
};

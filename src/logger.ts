// Minimal zero-dependency structured logger. JSON lines in production,
// pretty single-line in a TTY.

type Level = "debug" | "info" | "warn" | "error";

const pretty = process.stdout.isTTY;
const colors: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (pretty) {
    const c = colors[level];
    const tail = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
    // eslint-disable-next-line no-console
    console.log(`${c}${level.toUpperCase().padEnd(5)}\x1b[0m ${msg}${tail}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

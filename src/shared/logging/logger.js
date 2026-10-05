// Logger: privacy-safe technical details go to the bounded diagnostics history and the browser console.
// Raw objects are intentionally not printed: they can contain customer records, session tokens or provider responses.
import { recordLog } from './diagnostics.js';

const write = (level, args) => {
  const entry = recordLog(level, args), where = entry.file ? ` (${entry.file}${entry.line ? ":" + entry.line : ""})` : "";
  console[level](`[Hangtag] ${entry.message}${where}`);
};
export const logger = {
  error: (...args) => write("error", args),
  warn: (...args) => write("warn", args),
  info: (...args) => write("info", args),
};

// Logger: privacy-safe technical details go to the bounded diagnostics history and the browser console.
// Raw objects are intentionally not printed: they can contain customer records, session tokens or provider responses.
// Never pass a customer's, staff member's, supplier's or shop's name (or contact details, notes, document numbers) — see
// the rule in diagnostics.js. Prefer logger.event(category, kind, { op, code, status, ms, count }) for failures.
import { recordEvent, recordLog } from './diagnostics.js';

const write = (level, args) => {
  const entry = recordLog(level, args), where = entry.file ? ` (${entry.file}${entry.line ? ":" + entry.line : ""})` : "";
  console[level](`[Hangtag] ${entry.message}${where}`);
};
export const logger = {
  error: (...args) => write("error", args),
  warn: (...args) => write("warn", args),
  info: (...args) => write("info", args),
  /* A structured event (categories: diagnostics.js DIAG_CATEGORIES); fields: op, code, status, ms, count only */
  event: (category, kind, fields, level) => {
    const entry = recordEvent(category, kind, fields, level);
    console[entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info"](`[Hangtag] ${entry.category || "app"}: ${entry.message}${entry.code ? " " + entry.code : ""}`);
    return entry;
  },
};

// Privacy-safe technical diagnostics kept on this device. Entries are deliberately small and contain no app records:
// no customer/shop fields, document contents, contact details, URLs with parameters, auth tokens or provider keys.
// The bounded history powers Settings -> Advanced -> Diagnostics & health; it is never uploaded automatically.
import { APP_ENV } from '../config/app-config.js';
import { use } from '../di/services.js';

export const DIAGNOSTICS_KEY = "hangtag_diagnostics_v1";
export const DIAGNOSTICS_LIMIT = 50;
const MAX_BYTES = 48 * 1024, MAX_TEXT = 240;
let fallback = [];
const installedOn = new WeakSet();

const text = v => v == null ? "" : String(v);
const safeToken = (v, dflt) => {
  const s = text(v).toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  return s || dflt;
};
const safeCode = v => {
  const s = text(v).trim().toUpperCase();
  return /^[A-Z][A-Z0-9_.-]{1,39}$/.test(s) ? s : "";
};

/* Free text is useful only after values that can identify a person, document, account or credential are removed. */
export function sanitizeDiagnosticText(value){
  let s = text(value).replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s
    .replace(/\b(authorization|(?:access|refresh|id)?[_ -]?token|session|password|secret|api[_ -]?key|apikey)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, "bearer [token]")
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){1,2}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g, "[token]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/g, "[path]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b(?:\d{2})?[A-Z]{5}\d{4}[A-Z](?:[A-Z0-9]Z[A-Z0-9])?\b/gi, "[tax-id]")   // GSTIN (state + PAN + …) or a PAN alone
    .replace(/\b[A-Z]{2,5}(?:-[A-Z])?-\d{3,}\b/gi, "[document]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[number]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[network]")
    .replace(/\b(customer|supplier|product|bill|shop|user|owner|name|phone|email)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;]+)/gi, "$1=[redacted]")
    .replace(/(?:₹|Rs\.?|INR)\s*[\d,.]+/gi, "[amount]")
    .replace(/\s+/g, " ").trim();
  return s.slice(0, MAX_TEXT);
}

function errorOf(values){
  return (values || []).find(v => v && typeof v === "object" && (v instanceof Error || typeof v.message === "string")) || null;
}
function messageOf(values){
  const e = errorOf(values), first = (values || []).find(v => typeof v === "string");
  const a = first ? sanitizeDiagnosticText(first) : "";
  const b = e && e.message && e.message !== first ? sanitizeDiagnosticText(`${e.name || "Error"}: ${e.message}`) : "";
  return [a, b].filter(Boolean).join(" — ").slice(0, MAX_TEXT) || "Technical event";
}
function fileOf(value){
  const s = text(value); if(!s) return "";
  try{
    const p = new URL(s, "https://local.invalid/").pathname.split("/").filter(Boolean);
    return p.slice(-2).map(x => sanitizeDiagnosticText(decodeURIComponent(x))).join("/").slice(0, 100);
  }catch{
    return sanitizeDiagnosticText(s.split(/[\\/]/).slice(-2).join("/")).slice(0, 100);
  }
}
function locationOf(error, filename, line, column){
  let file = fileOf(filename), ln = Number.isInteger(+line) ? +line : 0, col = Number.isInteger(+column) ? +column : 0;
  if(!file && error && error.stack){
    const m = /(?:https?:\/\/[^\s)]+\/|[A-Za-z]:\\[^\n)]+\\)?([^\s\\/():]+\.m?js):(\d+):(\d+)/.exec(text(error.stack));
    if(m){ file = fileOf(m[1]); ln = +m[2]; col = +m[3]; }
  }
  return { ...(file ? { file } : {}), ...(ln > 0 && ln < 1e8 ? { line: ln } : {}), ...(col > 0 && col < 1e8 ? { column: col } : {}) };
}
function read(){
  let list = fallback;
  try{ const stored = use("storage").get(DIAGNOSTICS_KEY, fallback); if(Array.isArray(stored)) list = stored; }catch{}
  fallback = list.filter(x => x && typeof x === "object").slice(-DIAGNOSTICS_LIMIT);
  return fallback;
}
function write(list){
  let next = list.slice(-DIAGNOSTICS_LIMIT);
  while(next.length > 1 && JSON.stringify(next).length > MAX_BYTES) next.shift();
  fallback = next;
  try{ use("storage").set(DIAGNOSTICS_KEY, next); }catch{}
}

/* input: technical fields only; unknown object fields are never retained. */
export function recordDiagnostic(input = {}){
  const now = Number.isFinite(input.now) ? input.now : Date.now(), values = Array.isArray(input.values) ? input.values : [input.message, input.error];
  const error = input.error || errorOf(values), entry = {
    at: new Date(now).toISOString(),
    level: ["error", "warn", "info"].includes(input.level) ? input.level : "error",
    source: safeToken(input.source, "app"),
    kind: safeToken(input.kind || (error && error.name), "event"),
    message: messageOf(values),
    ...locationOf(error, input.filename, input.line, input.column),
  };
  const code = safeCode(input.code || (error && error.code)); if(code) entry.code = code;
  const status = +(input.status || (error && (error.status || error.statusCode))); if(Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status;
  const list = read().slice(), previous = list[list.length - 1];
  if(previous && previous.level === entry.level && previous.source === entry.source && previous.kind === entry.kind && previous.message === entry.message && now - Date.parse(previous.at) < 60000){
    list[list.length - 1] = { ...previous, at: entry.at, count: Math.min(999, (previous.count || 1) + 1) };
  }else list.push(entry);
  write(list);
  return { ...list[list.length - 1] };
}

export const recordLog = (level, values) => recordDiagnostic({ level, source: "logger", values });
export const getDiagnostics = () => read().map(x => ({ ...x }));
export function clearDiagnostics(){ write([]); }
export function diagnosticsSummary(){
  const entries = read(), errors = entries.filter(x => x.level === "error").length, warnings = entries.filter(x => x.level === "warn").length;
  return { count: entries.length, errors, warnings, latestAt: entries.length ? entries[entries.length - 1].at : null };
}
export function diagnosticsReport(health = {}){
  const cleanHealth = {
    environment: APP_ENV,
    online: !!health.online,
    cloud: safeToken(health.cloud, "unknown"),
    pending: Math.max(0, Math.min(99999, +health.pending || 0)),
    review: Math.max(0, Math.min(99999, +health.review || 0)),
    serviceWorker: safeToken(health.serviceWorker, "unknown"),
    build: sanitizeDiagnosticText(health.build || "unknown"),
  };
  return { schema: 1, createdAt: new Date().toISOString(), health: cleanHealth, diagnostics: getDiagnostics() };
}

/* Install once per window. Resource failures, synchronous errors and rejected promises all enter the same safe history. */
export function installGlobalDiagnostics(target = typeof window === "undefined" ? null : window){
  if(!target || typeof target.addEventListener !== "function" || installedOn.has(target)) return false;
  installedOn.add(target);
  target.addEventListener("error", event => {
    if(event && event.error) recordDiagnostic({ level: "error", source: "window.error", error: event.error, message: event.message, filename: event.filename, line: event.lineno, column: event.colno });
    else{
      const el = event && event.target, tag = el && el.tagName ? text(el.tagName).toLowerCase() : "resource";
      recordDiagnostic({ level: "error", source: "resource", kind: tag, message: `A ${tag} resource did not load.`, filename: el && (el.currentSrc || el.src || el.href) });
    }
  }, true);
  target.addEventListener("unhandledrejection", event => {
    const reason = event && event.reason;
    recordDiagnostic({ level: "error", source: "promise", kind: "unhandled-rejection", error: reason && typeof reason === "object" ? reason : null, message: typeof reason === "string" ? reason : "A background task failed." });
  });
  return true;
}

// Privacy-safe technical diagnostics kept on this device. Entries are deliberately small and contain no app records:
// no customer/shop fields, document contents, contact details, URLs with parameters, auth tokens or provider keys.
// The bounded history powers Settings -> Advanced -> Diagnostics & health; it is never uploaded automatically.
//
// THE RULE for code that logs: never put a customer's, staff member's, supplier's or shop's name (or phone, email, address,
// GSTIN, document number, note, amount tied to a person) into a diagnostic as free text. The sanitiser below removes what
// it can recognise (tokens, URLs, emails, phone numbers, tax ids, amounts, labelled fields) but a bare name can't be
// recognised reliably — so it must never be written in the first place. Use recordEvent / logger.event with a category,
// what happened, and technical fields only (an operation name such as a table, RPC, function, rule or tool name; a code;
// an HTTP status; a duration; a count). tests/unit/logging-discipline.test.mjs enforces this on every logging call.
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
  // an app or provider code (starts with a letter), or a 5-character SQLSTATE (23505, 42P01); never a longer number
  return /^[A-Z][A-Z0-9_.-]{1,39}$/.test(s) || /^[0-9A-Z]{5}$/.test(s) ? s : "";
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

/* The categories the health panel counts (structured events) */
export const DIAG_CATEGORIES = Object.freeze({ api: "Server calls", sync: "Sync", payment: "Payments", email: "Email", whatsapp: "WhatsApp",
  sms: "SMS", printer: "Printer", agent: "Agent tools", automation: "Automation", database: "Database" });
const safeOp = v => { const s = text(v).toLowerCase().replace(/[^a-z0-9_:.-]/g, "-").slice(0, 60); return /^[a-z0-9]/.test(s) ? s : ""; };
/* a duration as a band, never the exact time */
export const durationBand = ms => { const n = +ms; return !Number.isFinite(n) || n < 0 ? "" : n < 1000 ? "under 1 s" : n < 3000 ? "1–3 s" : n < 10000 ? "3–10 s" : n < 30000 ? "10–30 s" : "30 s or more"; };
/* A structured event: the category, what happened (kind: "upload-failed", "slow-call" …) and allowlisted technical fields —
   op (an operation name), code, status, ms (kept only as a band), count. Nothing else is read from fields. */
export function recordEvent(category, kind, fields = {}, level){
  const cat = Object.prototype.hasOwnProperty.call(DIAG_CATEGORIES, category) ? category : "app", what = safeToken(kind, "event");
  const f = fields && typeof fields === "object" ? fields : {}, op = safeOp(f.op), band = durationBand(f.ms);
  const n = Number.isInteger(+f.count) && +f.count > 1 ? Math.min(9999, +f.count) : 0;
  const message = `${what.replace(/-/g, " ")}${op ? " (" + op + ")" : ""}${band ? " · " + band : ""}${n ? " · " + n + " items" : ""}`;
  return recordDiagnostic({ level: ["error", "warn", "info"].includes(level) ? level : "error", source: cat, kind: what, category: cat, op,
    message, code: f.code, status: f.status });
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
  if(input.category) entry.category = safeToken(input.category, "app");
  if(input.op){ const op = safeOp(input.op); if(op) entry.op = op; }
  const code = safeCode(input.code || (error && error.code)); if(code) entry.code = code;
  const status = +(input.status || (error && (error.status || error.statusCode))); if(Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status;
  const list = read().slice(), previous = list[list.length - 1];
  if(previous && previous.level === entry.level && previous.source === entry.source && previous.kind === entry.kind && previous.message === entry.message && now - Date.parse(previous.at) < 60000){
    list[list.length - 1] = { ...previous, at: entry.at, count: Math.min(999, (previous.count || 1) + 1) };
  }else list.push(entry);
  write(list);
  return { ...list[list.length - 1] };
}

/* ---------- server-call latency: every call's time, as hourly counts per operation, for the last 24 hours ----------
   Kept by operation name only (rpc:hangtag_save_sales, table:hangtag_sales, fn:send-receipt, auth:token, storage) — never
   the address's values, the body or the answer. { [hour]: { [op]: { n, fail, sum, max, b: [under 1 s, 1–3, 3–10, 10–30, 30+] } } } */
export const LATENCY_KEY = "hangtag_latency_v1";
const BANDS = [1000, 3000, 10000, 30000], BAND_WORDS = ["under 1 s", "1–3 s", "3–10 s", "10–30 s", "30 s or more"], OPS_PER_HOUR = 40;
let latency = null, latencyTimer = null;
const readLatency = () => { if(latency) return latency; try{ const v = use("storage").get(LATENCY_KEY, {}); latency = v && typeof v === "object" && !Array.isArray(v) ? v : {}; }catch{ latency = {}; } return latency; };
const saveLatency = () => { if(latencyTimer) return; latencyTimer = setTimeout(() => { latencyTimer = null; try{ use("storage").set(LATENCY_KEY, latency || {}); }catch{} }, 1500); };
const bandOf = ms => { let i = 0; while(i < BANDS.length && ms >= BANDS[i]) i++; return i; };
/* an operation exactly as the client names it (rpc:…, table:…, fn:…, auth:…, storage) — anything else counts as "other" */
const LAT_OP = /^(?:(?:rpc|table|fn|auth):[a-z0-9_-]{1,60}|storage|other)$/;
export function recordLatency(op, ms, ok = true, now = Date.now()){
  const s = text(op).toLowerCase(), o = LAT_OP.test(s) ? s : "other", n = +ms; if(!Number.isFinite(n) || n < 0) return;
  const L = readLatency(), hour = Math.floor(now / 3600e3), H = L[hour] || (L[hour] = {});
  if(!H[o] && Object.keys(H).length >= OPS_PER_HOUR) return;
  const x = H[o] || (H[o] = { n: 0, fail: 0, sum: 0, max: 0, b: [0, 0, 0, 0, 0] });
  x.n++; if(!ok) x.fail++; x.sum += Math.round(n); x.max = Math.max(x.max, Math.round(n)); x.b[bandOf(n)]++;
  Object.keys(L).forEach(h => { if(+h < hour - 23) delete L[h]; });
  saveLatency();
}
const pBand = (b, p) => { const total = b.reduce((a, c) => a + c, 0); let run = 0; for(let i = 0; i < b.length; i++){ run += b[i]; if(run >= total * p) return BAND_WORDS[i]; } return BAND_WORDS[0]; };
/* The last `hours`: { calls, failed, avgMs, slow (3 s or more), ops: [{ op, calls, failed, avgMs, maxMs, p50, p95 }] } busiest first */
export function latencySummary(hours = 24, now = Date.now()){
  const L = readLatency(), from = Math.floor(now / 3600e3) - hours + 1, by = {};
  Object.entries(L).forEach(([h, H]) => { if(+h < from) return; Object.entries(H || {}).forEach(([op, x]) => {
    const y = by[op] || (by[op] = { n: 0, fail: 0, sum: 0, max: 0, b: [0, 0, 0, 0, 0] });
    y.n += +x.n || 0; y.fail += +x.fail || 0; y.sum += +x.sum || 0; y.max = Math.max(y.max, +x.max || 0); (x.b || []).forEach((c, i) => { if(i < 5) y.b[i] += +c || 0; }); }); });
  const ops = Object.entries(by).map(([op, y]) => ({ op, calls: y.n, failed: y.fail, avgMs: y.n ? Math.round(y.sum / y.n) : 0, maxMs: y.max, p50: pBand(y.b, 0.5), p95: pBand(y.b, 0.95), slow: y.b[2] + y.b[3] + y.b[4] }))
    .sort((a, b) => b.calls - a.calls || a.op.localeCompare(b.op));
  const calls = ops.reduce((a, o) => a + o.calls, 0);
  return { calls, failed: ops.reduce((a, o) => a + o.failed, 0), avgMs: calls ? Math.round(ops.reduce((a, o) => a + o.avgMs * o.calls, 0) / calls) : 0, slow: ops.reduce((a, o) => a + o.slow, 0), ops };
}
export function clearLatency(){ latency = {}; try{ use("storage").set(LATENCY_KEY, {}); }catch{} }

/* ---------- the Agent's chain: request → tool → result → action → approval → outcome ----------
   One trace per question, the latest TRACE_LIMIT kept on this device. Codes only: where it was answered (local or the AI
   provider), each tool's name and whether it worked (or what it tried was refused), how many rows came back, which screen
   opened, approved or dismissed, the outcome — never the question, a name, a number or an amount. */
export const TRACE_KEY = "hangtag_agent_traces_v1", TRACE_LIMIT = 20;
export const TRACE_STEPS = Object.freeze(["request", "tool", "result", "action", "approval", "outcome"]);
const STEPS_MAX = 30;
let traces = null, current = null;
const readTraces = () => { if(traces) return traces; try{ const v = use("storage").get(TRACE_KEY, []); traces = Array.isArray(v) ? v.filter(t => t && t.id).slice(-TRACE_LIMIT) : []; }catch{ traces = []; } return traces; };
const saveTraces = () => { try{ use("storage").set(TRACE_KEY, traces || []); }catch{} };
/* A new chain for a question (it becomes the current one: the tool host adds its tool steps to it) → its id */
export function startTrace(source, now = Date.now()){
  const T = readTraces(), id = "t" + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  T.push({ id, at: new Date(now).toISOString(), t0: now, source: safeToken(source, "agent"), steps: [] });
  while(T.length > TRACE_LIMIT) T.shift();
  current = id; saveTraces(); return id;
}
export const currentTrace = () => current;
export function endTrace(id){ if(current === id) current = null; }
/* A step: { op (a tool name, a screen, approved / dismissed, an outcome), ok, code, ms (as a band), count } */
export function traceStep(id, step, fields = {}, now = Date.now()){
  const t = id && readTraces().find(x => x.id === id); if(!t || !TRACE_STEPS.includes(step) || t.steps.length >= STEPS_MAX) return;
  const f = fields && typeof fields === "object" ? fields : {}, s = { step, ok: f.ok !== false };
  const op = safeOp(f.op); if(op) s.op = op;
  const code = safeCode(f.code); if(code) s.code = code;
  const band = durationBand(f.ms); if(band) s.time = band;
  if(Number.isInteger(+f.count) && +f.count >= 0) s.count = Math.min(9999, +f.count);
  s.after = durationBand(now - (+t.t0 || now));
  t.steps.push(s); saveTraces();
}
export const getTraces = () => readTraces().map(t => ({ id: t.id, at: t.at, source: t.source, steps: t.steps.map(s => ({ ...s })) }));
export function clearTraces(){ traces = []; current = null; saveTraces(); }

export const recordLog = (level, values) => recordDiagnostic({ level, source: "logger", values });
export const getDiagnostics = () => read().map(x => ({ ...x }));
export function clearDiagnostics(){ write([]); }
/* How many events of each category the history holds for the last `hours` (counts only; the history is bounded) */
export function categoryCounts(hours = 24, now = Date.now()){
  const since = now - hours * 3600e3, out = Object.fromEntries(Object.keys(DIAG_CATEGORIES).map(k => [k, 0]));
  read().forEach(e => { if(e.category && out[e.category] != null && Date.parse(e.at) >= since) out[e.category] += Math.max(1, +e.count || 1); });
  return out;
}
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
  return { schema: 3, createdAt: new Date().toISOString(), health: cleanHealth, last24h: categoryCounts(24), latency: latencySummary(24), agentChains: getTraces(), diagnostics: getDiagnostics() };
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

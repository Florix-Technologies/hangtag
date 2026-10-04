// Document numbers: what a customer reads on a bill (INV-000127), never the record's internal id.
//   · A number is the document type's prefix, this till's letter (none on the shop's main till), a zero-padded running
//     number and an optional suffix: INV-000127 · INV-B-000045 · INV/26-27/000127. The cashier never types one.
//   · Every document type has its own series (INV-, QT-, SO-, KOT-, PO-, CN-, DC-, RC-), and so does every till.
//   · The running number continues from one year to the next, or starts again every financial year (1 April) when the
//     prefix or suffix holds {FY} (shown as 26-27): the year is then part of the number, so two documents of the shop
//     never share a number (supabase/schema.sql hangtag_doc_no_check refuses a bill or credit note number used twice).
//   · Two tills never make the same number, even while both are offline: the first device to make documents uses the
//     shop's main series, and every other device gets a series of its own (B, C, …), kept on that device.
//   · A number already given is never changed (numbers in earlier formats, e.g. INV-260929-K3F001, stay as they are).
// GST (rule 46): at most 16 characters of letters, digits, "-" and "/", consecutive within each series.
import { pad } from '../../shared/formatting/dates.js';

export const DOC_NO_MAX = 16;
/* Every document type's prefix (bills and quotations: the shop's own, from its settings) */
export const DOC_PREFIXES = Object.freeze({ invoice: "INV-", quote: "QT-", sales: "SO-", table: "KOT-", po: "PO-", credit: "CN-", challan: "DC-", receipt: "RC-" });
export const DEFAULT_NUMBERING = Object.freeze({ prefix: "INV-", start: 1, padding: 6, suffix: "" });
/* A second, third … till's letter (no A: that's the main till; no I or O, read as 1 and 0) */
export const TILL_LETTERS = "BCDEFGHJKLMNPQRSTUVWXYZ";
const FY_TOKEN = /\{FY\}/gi;

/* The Indian financial year (April to March) of a time, as printed in a number: 26-27 */
export function fyLabel(t){
  const d = new Date(t), start = d.getFullYear() - (d.getMonth() < 3 ? 1 : 0);
  return pad(start % 100) + "-" + pad((start + 1) % 100);
}
/* Does this numbering start again every financial year (its prefix or suffix holds {FY})? */
export const yearlyNumbering = cfg => /\{FY\}/i.test(String(cfg.prefix || "") + String(cfg.suffix || ""));
const expand = (s, t) => String(s || "").replace(FY_TOKEN, fyLabel(t));
/* The separator between a till's letter and the running number: the prefix's own ("INV-" → "-", "INV/" → "/") */
const sepOf = prefix => /[-/]$/.test(prefix) ? prefix.slice(-1) : "-";
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* A numbering as saved (any part may be missing or a string from a form) → { prefix, start, padding, suffix } */
export function numberingOf(input, prefix){
  const x = input && typeof input === "object" ? input : {}, n = (v, d) => Number.isInteger(+v) && +v > 0 ? +v : d;
  return { prefix: String(x.prefix == null || x.prefix === "" ? (prefix == null ? DEFAULT_NUMBERING.prefix : prefix) : x.prefix),
    start: n(x.start, DEFAULT_NUMBERING.start), padding: Math.min(8, Math.max(3, n(x.padding, DEFAULT_NUMBERING.padding))), suffix: String(x.suffix || "") };
}
/* The number of document `seq` of a series at time t: INV-000127, INV-B-000045 (till B) */
export function formatDocNo(cfg, t, seq, till = ""){
  const c = numberingOf(cfg), pre = expand(c.prefix, t);
  return pre + (till ? till + sepOf(pre) : "") + String(seq).padStart(c.padding, "0") + expand(c.suffix, t);
}
/* A number of this numbering read back: { till ("" on the main till), seq, fy (when the number holds the year) } or null
   (a number in another format, e.g. one made before). Any count of digits is read, so changing the padding keeps the series. */
export function parseDocNo(no, cfg){
  const c = numberingOf(cfg), part = s => reEsc(s).replace(/\\\{FY\\\}/gi, "(?<fy>\\d{2}-\\d{2})");
  const sep = c.prefix.replace(FY_TOKEN, "00-00");
  const re = new RegExp("^" + part(c.prefix) + "(?:(?<till>[" + TILL_LETTERS + "])" + reEsc(sepOf(sep)) + ")?(?<seq>\\d+)" + part(c.suffix) + "$");
  const m = re.exec(String(no || ""));
  return m ? { till: m.groups.till || "", seq: +m.groups.seq, fy: m.groups.fy || "" } : null;
}
/* The next running number of a series. docs: the documents of that type the device knows ({ no }), from every device.
   1 + the highest number already in the series (the same till, and the same year when the number holds it), and never
   below the starting number. */
export function nextDocSeq(docs, cfg, t, till = ""){
  const c = numberingOf(cfg), fy = yearlyNumbering(c) ? fyLabel(t) : "";
  let top = c.start - 1;
  (docs || []).forEach(d => { const p = d && parseDocNo(d.no, c); if(p && p.till === till && p.fy === fy) top = Math.max(top, p.seq); });
  return top + 1;
}
export const nextDocNo = (docs, cfg, t, till = "") => formatDocNo(cfg, t, nextDocSeq(docs, cfg, t, till), till);

/* Which series this device makes documents in: "" (the shop's main series) or a till letter.
   stored: this device's saved choice ("" / a letter), or null before its first document. docs: every document the device
   knows, of every type, with its numbering: [{ no, dev, cfg }]. A device that already made documents keeps its series;
   otherwise the first device takes the main series and any other device the first letter no other device uses. */
export function tillFor({ stored, dev, docs }){
  if(stored === "" || (typeof stored === "string" && stored.length === 1 && TILL_LETTERS.includes(stored))) return stored;
  const read = (docs || []).map(d => ({ dev: d.dev, t: +d.t || 0, p: d && parseDocNo(d.no, d.cfg) })).filter(x => x.p);
  const mine = read.filter(x => x.dev && x.dev === dev).sort((a, b) => b.t - a.t);
  if(mine.length) return mine[0].p.till;
  const others = read.filter(x => x.dev !== dev);
  if(!others.some(x => x.p.till === "")) return "";
  return freeTill(others.map(x => x.p.till));
}
/* A number this device made was refused because another device of the shop already has it (both took the same series):
   the next free letter, never the series that clashed */
export function tillAfterConflict(current, { dev, docs }){
  const used = (docs || []).map(d => ({ dev: d.dev, p: d && parseDocNo(d.no, d.cfg) })).filter(x => x.p && x.dev !== dev).map(x => x.p.till);
  return freeTill([...used, current]);
}
function freeTill(used){
  const taken = new Set(used.filter(Boolean));
  return [...TILL_LETTERS].find(l => !taken.has(l)) || TILL_LETTERS[TILL_LETTERS.length - 1];
}

/* Billing & Documents → Bill numbering, as typed → { config, preview, length, warning } or { error, field }.
   till: this device's series (its numbers must fit in 16 characters); a second till's numbers are checked too (a warning). */
export function checkNumberingSettings(input, { t = Date.now(), till = "" } = {}){
  const x = input || {}, up = v => String(v == null ? "" : v).trim().toUpperCase();
  const prefix = up(x.prefix == null ? DEFAULT_NUMBERING.prefix : x.prefix), suffix = up(x.suffix);
  const start = +String(x.start == null || x.start === "" ? DEFAULT_NUMBERING.start : x.start).trim();
  const padding = +String(x.padding == null || x.padding === "" ? DEFAULT_NUMBERING.padding : x.padding).trim();
  const plain = s => s.replace(/\{FY\}/g, "");
  if(!plain(prefix) || !/^[A-Z0-9]/.test(prefix) || !/^[A-Z0-9/-]*$/.test(plain(prefix)) || plain(prefix).length > 10)
    return { error: "Prefix: up to 10 letters or numbers, with - or / (e.g. INV-). Add {FY} for the financial year.", field: "prefix" };
  if(!/^[A-Z0-9/-]*$/.test(plain(suffix)) || plain(suffix).length > 8)
    return { error: "Suffix: up to 8 letters or numbers, with - or / (e.g. /{FY} or -A). Leave it empty for none.", field: "suffix" };
  if(((prefix + suffix).match(/\{FY\}/g) || []).length > 1) return { error: "Use {FY} once, in the prefix or the suffix.", field: "suffix" };
  if(!Number.isInteger(start) || start < 1 || start > 99999999) return { error: "Starting number: a whole number from 1 to 99,999,999.", field: "start" };
  if(!Number.isInteger(padding) || padding < 3 || padding > 8) return { error: "Digits: from 3 to 8.", field: "padding" };
  const config = { prefix, start, padding, suffix }, digits = Math.max(padding, String(start).length);
  const longest = l => formatDocNo(config, t, Math.pow(10, digits - 1), l).length;
  const preview = formatDocNo(config, t, start, till), length = longest(till);
  if(length > DOC_NO_MAX) return { error: `These numbers would be ${length} characters; GST invoices allow at most ${DOC_NO_MAX}. Shorten the prefix or suffix, or use fewer digits.`, field: "length", preview, length };
  const other = till ? "" : TILL_LETTERS[0], otherLength = other ? longest(other) : length;
  const warning = otherLength > DOC_NO_MAX ? `A second till's numbers (${formatDocNo(config, t, start, other)}) would be ${otherLength} characters, over the ${DOC_NO_MAX} GST allows. Use fewer digits if another device will make bills.` : "";
  return { config, preview, length, warning, yearly: yearlyNumbering(config) };
}

/* ---------- numbers made before (kept as they are) ---------- */
const ymd = t => { const d = new Date(t); return String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()); };
/* The code of a device in numbers made before: 3 characters 0-9 A-Z from the device id */
export function deviceCode(dev){
  let h = 2166136261;
  for(const ch of String(dev || "")){ h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 46656).toString(36).toUpperCase().padStart(3, "0");
}
/* A bill saved before bills had numbers is shown with prefix, date and its place that day: INV-250925-004 */
export const legacyInvoiceNo = (prefix, t, seq) => (prefix || "") + ymd(t) + "-" + String(seq).padStart(3, "0");
/* A number of the earlier per-day, per-device format read back: "INV-260929-K3F012" → { series: "INV-260929-K3F", n: 12 }, or null */
export function splitDeviceNo(no){
  const m = /^(.*\d{6}-[0-9A-Z]{3})(\d{3,})$/.exec(String(no || ""));
  return m ? { series: m[1], n: +m[2] } : null;
}

// GS1 beyond the plain retail barcode: what a GS1 code scanned at the counter or at stock-in says. Pure.
//   GTINs   — GTIN-8 / -12 (UPC-A) / -13 (EAN-13) / -14 are one number written with leading zeros: gtinKey() gives every
//             valid one as 14 digits, so a product saved with its EAN-13 is found from a UPC-A, a GTIN-14 with a 0
//             indicator, a GS1 DataMatrix or a GS1 Digital Link of the same item
//   element strings (GS1-128, GS1 DataMatrix, GS1 QR, DataBar) — Application Identifiers: (01) GTIN, (10) batch / lot,
//             (11) production date, (15) best before, (17) expiry, (21) serial, (310n) net weight in kg, (392n) price.
//             Accepted as scanners type them: with the symbology identifier (]C1 ]d2 ]Q3 ]e0), with FNC1 as the GS
//             character or its stand-ins (<GS> {GS} ^]), or human-readable with brackets: (01)09506000134352(17)270131
//   GS1 Digital Link — https://<any domain>/01/<GTIN>[/10/<batch>][/21/<serial>][?17=YYMMDD…] (the 2D codes GS1 is
//             moving the counter to; "gtin", "lot" and "ser" are accepted for 01, 10 and 21)
// A pack's GTIN is that pack's: a case (indicator 1–8 in front) is a different trade item and only matches itself.
import { gs1CheckDigit } from './barcode.js';

const GS = "\u001d";
/* AIs with a fixed length of data (the digits after the AI); the others run to the next GS or the end */
const FIXED = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
const NAMES = { "01": "gtin", "10": "batch", "11": "produced", "15": "bestBefore", "17": "expiry", "21": "serial" };
const MAX_VAR = 30;

/* A valid GTIN-8/12/13/14 as 14 digits; null for anything else (wrong length, letters, a wrong check digit) */
export function gtinKey(code){
  const d = String(code == null ? "" : code).trim();
  if(!/^(\d{8}|\d{12,14})$/.test(d) || gs1CheckDigit(d.slice(0, -1)) !== +d[d.length - 1]) return null;
  return d.padStart(14, "0");
}
/* YYMMDD → YYYY-MM-DD (a day of 00 is the month's last day, as GS1 has it); null when it isn't a date */
export function gs1Date(yymmdd, now = new Date()){
  if(!/^\d{6}$/.test(String(yymmdd || ""))) return null;
  const yy = +yymmdd.slice(0, 2), mm = +yymmdd.slice(2, 4); let dd = +yymmdd.slice(4, 6);
  if(mm < 1 || mm > 12) return null;
  let year = 2000 + yy; if(year > now.getFullYear() + 50) year -= 100;
  const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  if(dd === 0) dd = last;
  if(dd > last) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
/* The fields a GS1 code carries: { gtin, batch?, serial?, expiry?, bestBefore?, produced?, netWeightKg?, price?, source } */
function fieldsOf(ais, source){
  const out = { source };
  const gtin = ais["01"] && gtinKey(ais["01"]); if(!gtin) return null;
  out.gtin = gtin;
  Object.entries(NAMES).forEach(([ai, k]) => { if(ai !== "01" && ais[ai]) out[k] = /^1[157]$/.test(ai) ? gs1Date(ais[ai]) : ais[ai].slice(0, 20); });
  Object.entries(ais).forEach(([ai, v]) => {
    if(/^310\d$/.test(ai) && /^\d{6}$/.test(v)) out.netWeightKg = +v / 10 ** +ai[3];
    if(/^392\d$/.test(ai) && /^\d{1,15}$/.test(v)) out.price = +v / 10 ** +ai[3];
  });
  ["expiry", "bestBefore", "produced"].forEach(k => { if(out[k] === null) delete out[k]; });
  return out;
}
/* Element strings: "(01)…(17)…" or "]d2" + "01…17…10…<GS>21…" */
function parseElements(raw){
  let s = String(raw).replace(/^\](C1|d2|Q3|e0|J1)/, "").replace(/<GS>|\{GS\}|\^\]/g, GS).trim();
  const ais = {};
  if(/^\(\d{2,4}\)/.test(s)){
    const re = /\((\d{2,4})\)([^(]*)/g; let m, n = 0;
    while((m = re.exec(s))){ ais[m[1]] = m[2].replace(new RegExp(GS, "g"), "").trim(); n += m[0].length; }
    return n === s.length ? ais : null;
  }
  if(!/^(01|02|00)\d/.test(s)) return null;   // a GS1 element string starts with its key
  while(s.length){
    if(s[0] === GS){ s = s.slice(1); continue; }
    const two = s.slice(0, 2), four = s.slice(0, 4), three = s.slice(0, 3);
    let ai, len = null;
    if(FIXED[two]){ ai = two; len = FIXED[two]; }
    else if(/^3[1-6]\d\d$/.test(four)){ ai = four; len = 6; }
    else if(/^41\d$/.test(three)){ ai = three; len = 13; }
    else if(/^(10|21|22|30|37)$/.test(two)) ai = two;
    else if(/^39[23]\d$/.test(four) || /^(240|241|400|401|402|403)$/.test(three)) ai = /^39/.test(four) ? four : three;
    else return Object.keys(ais).length ? ais : null;   // an AI this app doesn't read: keep what came before it
    s = s.slice(ai.length);
    if(len != null){ if(s.length < len) return null; ais[ai] = s.slice(0, len); s = s.slice(len); }
    else { const end = s.indexOf(GS), v = end < 0 ? s : s.slice(0, end); if(v.length > MAX_VAR) return null; ais[ai] = v; s = end < 0 ? "" : s.slice(end + 1); }
  }
  return ais;
}
/* GS1 Digital Link: path pairs after the primary key, and AIs in the query */
function parseLink(raw){
  let u; try{ u = new URL(String(raw).trim()); }catch{ return null; }
  if(!/^https?:$/.test(u.protocol)) return null;
  const parts = u.pathname.split("/").filter(Boolean).map(x => decodeURIComponent(x)), alias = { gtin: "01", lot: "10", ser: "21", cpv: "22" };
  const i = parts.findIndex(x => x === "01" || x === "gtin"); if(i < 0) return null;
  const ais = {};
  for(let k = i; k + 1 < parts.length; k += 2){ const ai = alias[parts[k]] || parts[k]; if(!/^\d{2,4}$/.test(ai)) break; ais[ai] = parts[k + 1]; }
  u.searchParams.forEach((v, k) => { if(/^\d{2,4}$/.test(k) && !(k in ais)) ais[k] = v; });
  return ais;
}
/* What a scanned GS1 code says, or null when it isn't one (a plain barcode, SKU or other text) */
export function parseGs1(raw){
  const t = String(raw == null ? "" : raw);
  if(!t.trim()) return null;
  if(/^https?:\/\//i.test(t.trim())){ const ais = parseLink(t); return ais ? fieldsOf(ais, "digital-link") : null; }
  const ais = parseElements(t); return ais ? fieldsOf(ais, "element-string") : null;
}
/* Is a stored code this GTIN? (any valid GTIN length) */
export const sameGtin = (stored, gtin) => !!gtin && gtinKey(stored) === gtin;

// Barcodes as SVG: vector and crisp when printed. EAN-13, UPC-A and EAN-8 get their guard bars and the digits under the
// bars; any other code is drawn as Code 128 (set B, switching to set C for runs of digits whenever that makes it shorter).
// Coordinates are whole modules (the narrowest bar): the viewBox is W×H modules and width/height carry the real size.
import { CODE_MAX_LEN, symbologyFor } from '../../domain/catalog/barcode.js';
import { AppError, ERROR_CODES } from '../../shared/errors/app-error.js';
import { esc } from '../../shared/dom.js';

/* ---------- EAN / UPC ---------- */
// L codes (odd parity); R = L with bars and spaces swapped; G = R backwards. "1" = bar, one character per module.
const EAN_L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const flip = p => p.replace(/[01]/g, b => b === "1" ? "0" : "1");
const EAN_R = EAN_L.map(flip);
const EAN_G = EAN_R.map(p => [...p].reverse().join(""));
// EAN-13: the first digit isn't drawn as bars; it picks L or G for each of the next six digits
const EAN_PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
const GUARD = "101", CENTRE = "01010";

/* Modules of an EAN-13 / UPC-A / EAN-8, the stretches drawn as long (guard) bars, and where the digits go
   (x = left edge of the first digit's 7-module character, from the symbol's left edge) */
function eanSymbol(code, sym){
  const d = [...code].map(Number), L = x => EAN_L[x], R = x => EAN_R[x];
  if(sym === "ean13"){
    const par = EAN_PARITY[d[0]];
    return { bits: GUARD + d.slice(1, 7).map((x, i) => (par[i] === "L" ? EAN_L : EAN_G)[x]).join("") + CENTRE + d.slice(7).map(R).join("") + GUARD,
      long: [[0, 3], [45, 50], [92, 95]], groups: [{ text: code.slice(1, 7), x: 3 }, { text: code.slice(7), x: 50 }], lead: code[0], trail: null };
  }
  if(sym === "upca")   // the number-system and check digits are drawn as long bars and printed small, outside the guards
    return { bits: GUARD + d.slice(0, 6).map(L).join("") + CENTRE + d.slice(6).map(R).join("") + GUARD,
      long: [[0, 10], [45, 50], [85, 95]], groups: [{ text: code.slice(1, 6), x: 10 }, { text: code.slice(6, 11), x: 50 }], lead: code[0], trail: code[11] };
  return { bits: GUARD + d.slice(0, 4).map(L).join("") + CENTRE + d.slice(4).map(R).join("") + GUARD,   // ean8
    long: [[0, 3], [31, 36], [64, 67]], groups: [{ text: code.slice(0, 4), x: 3 }, { text: code.slice(4), x: 36 }], lead: null, trail: null };
}

/* ---------- Code 128 ---------- */
// Bar/space widths of symbol values 0–106 (bar first). 99 = Code C, 100 = Code B, 104 = Start B, 105 = Start C, 106 = Stop.
const C128 = ("212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 " +
  "123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 " +
  "111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 " +
  "231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 " +
  "141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 " +
  "124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 " +
  "311141 411131 211412 211214 211232 2331112").split(" ");
const CODE_C = 99, CODE_B = 100, START_B = 104, START_C = 105, STOP = 106;
const widthsToBits = w => [...w].map((n, i) => (i % 2 ? "0" : "1").repeat(+n)).join("");

/* Symbol values for text (printable ASCII): start, data (with set switches), checksum, stop. The sets are chosen for the
   fewest symbols (then the fewest switches, then set B), e.g. "12345678" → Start C 12 34 56 78, "SKU-1" → all set B. */
export function code128Values(text){
  const n = text.length, digit = i => i < n && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57, pair = i => digit(i) && digit(i + 1);
  const add = (a, s, w) => [a[0] + s, a[1] + w], less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  // best[i] = cheapest [symbols, switches] for text[i..] while in set B (b) or C (c), and the step that gets it
  const b = Array(n + 1), c = Array(n + 1);
  b[n] = c[n] = { cost: [0, 0] };
  for(let i = n - 1; i >= 0; i--){
    b[i] = { cost: add(b[i + 1].cost, 1, 0), step: "B" };                                   // one character in B
    if(pair(i)){ const sw = add(c[i + 2].cost, 2, 1); if(less(sw, b[i].cost)) b[i] = { cost: sw, step: "toC" }; }   // Code C + a pair
    const back = { cost: add(b[i + 1].cost, 2, 1), step: "toB" };                          // Code B + one character
    c[i] = pair(i) && !less(back.cost, add(c[i + 2].cost, 1, 0)) ? { cost: add(c[i + 2].cost, 1, 0), step: "C" } : back;
  }
  let inC = n > 0 && less(c[0].cost, b[0].cost) && c[0].step === "C";
  const out = [inC ? START_C : START_B];
  for(let i = 0; i < n;){
    const step = (inC ? c : b)[i].step;
    if(step === "toC"){ out.push(CODE_C); inC = true; continue; }
    if(step === "toB"){ out.push(CODE_B); inC = false; continue; }
    if(inC){ out.push(+text.slice(i, i + 2)); i += 2; } else { out.push(text.charCodeAt(i) - 32); i++; }
  }
  out.push(out.reduce((s, v, i) => s + v * (i || 1), 0) % 103, STOP);
  return out;
}
// (the stop pattern's 7th element is the 2-module termination bar, so a symbol is 11 modules per value + 13)
const code128Symbol = text => ({ bits: code128Values(text).map(v => widthsToBits(C128[v])).join(""), long: [], groups: [], lead: null, trail: null });

/* ---------- SVG ---------- */
export const BARCODE_NAMES = { ean13: "EAN-13", upca: "UPC-A", ean8: "EAN-8", code128: "Code 128" };
const QUIET = { ean13: [11, 7], upca: [9, 9], ean8: [7, 7], code128: [10, 10] };   // minimum light margins (modules), per GS1 / ISO 15417
const BAR_HEIGHT = { ean13: 69, upca: 69, ean8: 55 };                              // nominal bar heights (modules); Code 128: 15% of its length, at least 40
const MODULE = { mm: 0.33, cm: 0.033, in: 0.013, pt: 0.936, px: 2 };               // default module width per unit (0.33 mm = EAN at 100%)
const DIGIT_PAD = 7;       // modules kept left/right of the guards for the EAN-13 / UPC-A digits printed outside the bars
const MIN_BARS = 10;       // below this bar height the digits are left out so the bars keep the space
const GLYPH = 0.62;        // digit width / font size (a little wider than most fonts' digits)
const FONT = "'OCR-B','OCR B',Arial,Helvetica,sans-serif";
const fmt = n => String(+n.toFixed(3));
function positive(v, name, dflt){
  if(v === undefined || v === null) return dflt;
  const n = +v;
  if(!Number.isFinite(n) || n <= 0) throw new RangeError(`barcodeSVG: ${name} must be a positive number`);
  return n;
}

/**
 * The barcode for a stored code as an SVG string. The symbol follows the code (see symbologyFor): EAN-13 / UPC-A / EAN-8
 * when it is a valid one, otherwise Code 128. opts (all optional):
 *   unit     "mm" (default) | "cm" | "in" | "pt" | "px" — unit of every size below and of the width/height attributes
 *   module   narrowest bar width (default 0.33 mm);  width: total width including the margins (sets the module width instead)
 *   height   total height, bars + digits (default: the nominal bar height for the symbol + the digits); when it is too
 *            small for both, the digits are left out
 *   text     true (default): print the digits / text under the bars
 *   fontSize size of those digits (default 11 modules for EAN/UPC, 10 for Code 128)
 *   quiet    true (default): the standard light margins; false/0: none; a number: that many modules each side
 *   symbology "code128" to draw an EAN/UPC number as Code 128 instead
 *   color    bar colour (default "#000");  background: default "#fff", null for none
 * Throws an AppError (VALIDATION) when the code is empty, too long or has characters a barcode can't hold.
 */
export function barcodeSVG(code, opts = {}){
  code = String(code ?? "");
  const auto = symbologyFor(code);
  if(!auto) throw new AppError(ERROR_CODES.VALIDATION, code ? `This code can't be printed as a barcode: use up to ${CODE_MAX_LEN} plain letters, numbers, spaces and symbols.` : "There's no code to print.");
  const sym = opts.symbology ?? auto;
  if(!BARCODE_NAMES[sym]) throw new RangeError(`barcodeSVG: unknown symbology ${sym}`);
  if(sym !== auto && sym !== "code128") throw new AppError(ERROR_CODES.VALIDATION, `${code} isn't a valid ${BARCODE_NAMES[sym]} barcode.`);
  const unit = opts.unit ?? "mm";
  if(!(unit in MODULE)) throw new RangeError(`barcodeSVG: unit must be one of ${Object.keys(MODULE).join(", ")}`);

  const s = sym === "code128" ? code128Symbol(code) : eanSymbol(code, sym);
  const symW = s.bits.length;
  let text = opts.text === undefined ? true : !!opts.text;
  const qn = opts.quiet === undefined || opts.quiet === true ? null : !opts.quiet ? 0 : Math.round(positive(opts.quiet, "quiet"));
  const [qL, qR] = qn === null ? QUIET[sym] : [qn, qn];
  const padL = text && s.lead ? Math.max(qL, DIGIT_PAD) : qL, padR = text && s.trail ? Math.max(qR, DIGIT_PAD) : qR;
  const W = padL + symW + padR;
  const module = opts.width != null ? positive(opts.width, "width") / W : positive(opts.module, "module", MODULE[unit]);
  const fs = opts.fontSize != null ? positive(opts.fontSize, "fontSize") / module : sym === "code128" ? 10 : 11;
  const band = () => text ? Math.ceil(fs * 0.72 + 2) : 0;          // digit height + a module above and below
  const H = opts.height != null ? Math.max(1, Math.round(positive(opts.height, "height") / module))
    : (BAR_HEIGHT[sym] ?? Math.max(40, Math.round(symW * 0.15))) + band();
  if(text && H - band() < MIN_BARS) text = false;
  const barH = H - band(), longH = text ? Math.min(H, barH + Math.round(fs * 0.45)) : barH;
  const inLong = x => s.long.some(([a, b]) => x >= a && x < b);
  const ink = esc(opts.color ?? "#000");

  let d = "";
  for(let x = 0; x < symW;){
    if(s.bits[x] !== "1"){ x++; continue; }
    let w = 1; while(s.bits[x + w] === "1") w++;
    d += `M${padL + x} 0h${w}v${inLong(x) ? longH : barH}h-${w}z`;
    x += w;
  }
  let t = "";
  if(text){
    const y = fmt(barH + band() - 1);
    const label = (x, str, size, extra = "") => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${fmt(size)}" text-anchor="middle" fill="${ink}"${extra}>${esc(str)}</text>`;
    if(sym === "code128"){
      const fit = code.length * fs * 0.6 > symW ? ` textLength="${symW}" lengthAdjust="spacingAndGlyphs"` : "";
      t = label(fmt(padL + symW / 2), code, fs, ` xml:space="preserve"${fit}`);
    } else {
      // each digit centred under its own 7-module character; the EAN-13 first digit and the UPC-A outer digits beside the guards
      for(const g of s.groups) t += label([...g.text].map((_, i) => fmt(padL + g.x + 7 * i + 3.5)).join(" "), g.text, fs);
      const outer = sym === "upca" ? fs * 0.75 : fs;
      if(s.lead){ const sz = Math.min(outer, (padL - 1) / GLYPH); t += label(fmt(padL - 1 - sz * GLYPH / 2), s.lead, sz); }
      if(s.trail){ const sz = Math.min(outer, (padR - 1) / GLYPH); t += label(fmt(padL + symW + 1 + sz * GLYPH / 2), s.trail, sz); }
    }
  }
  const bg = opts.background === null || opts.background === "none" ? "" : `<rect width="${W}" height="${H}" fill="${esc(opts.background ?? "#fff")}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W * module)}${unit}" height="${fmt(H * module)}${unit}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" role="img" aria-label="${esc(BARCODE_NAMES[sym] + " " + code)}">` +
    `${bg}<path fill="${ink}" d="${d}"/>${t}</svg>`;
}

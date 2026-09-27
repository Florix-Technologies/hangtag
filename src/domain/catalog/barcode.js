// Barcode rules: GS1 check digits (EAN-13, UPC-A, EAN-8), in-store code generation, which symbol a code prints as.
// Pure: no browser, no state. Drawing lives in infrastructure/codes/ (barcode-svg.js, qr-svg.js).

export const CODE_MAX_LEN = 64;
/* Generated in-store codes: EAN-13 starting "20" (GS1 restricted circulation: only valid inside this shop, never on a
   manufacturer's product, and not the 21–29 ranges some tills read as weight/price codes) */
export const INSTORE_PREFIX = "20";

/* A code as it is stored and compared: trimmed, at most 64 characters */
export const cleanCode = s => String(s ?? "").trim().slice(0, CODE_MAX_LEN);
/* Printable ASCII only (space … ~): what Code 128 set B can draw and every scanner types back unchanged */
export const isPrintableCode = s => typeof s === "string" && /^[\x20-\x7e]+$/.test(s);

/* GS1 check digit of the digits before it (weights 3,1,3… from the right): EAN-13 (12 digits), UPC-A (11), EAN-8 (7) */
export function gs1CheckDigit(body){
  const d = String(body ?? "");
  if(!/^\d+$/.test(d)) return null;
  let sum = 0;
  for(let i = d.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += +d[i] * w;
  return (10 - sum % 10) % 10;
}
/* Check digit of the first 12 digits of an EAN-13; null when d12 isn't exactly 12 digits */
export const ean13CheckDigit = d12 => /^\d{12}$/.test(String(d12 ?? "")) ? gs1CheckDigit(d12) : null;
const validGs1 = (s, n) => typeof s === "string" && s.length === n && /^\d+$/.test(s) && gs1CheckDigit(s.slice(0, -1)) === +s[n - 1];
export const isValidEan13 = s => validGs1(s, 13);
export const isValidUpcA = s => validGs1(s, 12);
export const isValidEan8 = s => validGs1(s, 8);

/* The symbol a stored code prints as: a valid EAN-13 / UPC-A / EAN-8 as that retail barcode, any other printable text
   (up to 64 characters) as Code 128. null for an empty, too long or non-printable code. The code is used exactly as given. */
export function symbologyFor(code){
  if(!isPrintableCode(code) || code.length > CODE_MAX_LEN) return null;
  if(isValidEan13(code)) return "ean13";
  if(isValidUpcA(code)) return "upca";
  if(isValidEan8(code)) return "ean8";
  return "code128";
}

/* Why a code typed by the merchant can't be used, or null when it can ("" = no code, also fine).
   8, 12 or 13 digits must be a valid EAN-8 / UPC-A / EAN-13 (a wrong last digit is almost always a typo). */
export function codeError(code){
  const c = cleanCode(code);
  if(!c) return null;
  if(String(code ?? "").trim().length > CODE_MAX_LEN) return `A code can be at most ${CODE_MAX_LEN} characters.`;
  if(!isPrintableCode(c)) return "Use only plain letters, numbers, spaces and symbols in a code.";
  const kind = { 8: "EAN-8", 12: "UPC-A", 13: "EAN-13" }[c.length];
  if(kind && /^\d+$/.test(c) && !validGs1(c, c.length))
    return `${c} isn't a valid ${kind} barcode: the last digit should be ${gs1CheckDigit(c.slice(0, -1))}. Check the number.`;
  return null;
}

/* A new in-store EAN-13 ("20" + 10 digits + check digit) that is not in `taken` (Set or array of codes; compared
   exactly). rand() returns [0, 1) like Math.random; pass a seeded one for repeatable results. After a few random tries it
   walks forward from the last candidate, so it always finishes (at most taken.size + 1 more steps). */
export function generateEan13(taken, rand = Math.random){
  const has = taken instanceof Set ? c => taken.has(c) : (s => c => s.has(c))(new Set(Array.from(taken || [], String)));
  const SPAN = 1e10;   // 10 free digits after the prefix
  const make = n => { const d12 = INSTORE_PREFIX + String(n).padStart(10, "0"); return d12 + gs1CheckDigit(d12); };
  const digit = () => { const r = +rand(); return Number.isFinite(r) ? Math.min(9, Math.max(0, Math.floor(r * 10))) : 0; };
  let n = 0;
  for(let t = 0; t < 8; t++){
    n = 0;
    for(let i = 0; i < 10; i++) n = n * 10 + digit();
    if(!has(make(n))) return make(n);
  }
  const limit = (taken instanceof Set ? taken.size : Array.from(taken || []).length) + 1;
  for(let i = 1; i <= limit && i < SPAN; i++){ const c = make((n + i) % SPAN); if(!has(c)) return c; }
  throw new Error("No free in-store barcode left.");
}

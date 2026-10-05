// Money and number formatting, in the shop's currency (regions.js; India by default: ₹ and en-IN grouping). The one path
// every amount takes wherever it is written — screens, totals, reports, bills, invoices, receipts, documents, PDFs and
// thermal prints — so another currency is a region, not a change to the POS or the documents. One amount, three outputs:
//   "screen"   the app, the A4 documents (preview and print), pictures and messages: the region's symbol (₹)
//   "pdf"      the PDF's built-in fonts (WinAnsi): the symbol where the font has it (£, $), its plain form otherwise (Rs.)
//   "thermal"  receipt printers (plain ASCII): the plain form wherever the symbol isn't ASCII (Rs., GBP)
// The app's region sets it (configureMoney); the screen names stay inr / inrx / inrShort, which every screen already uses.
import { REGIONS, compactParts } from './regions.js';

let R = REGIONS.IN;
/* The region money is written for ({ symbol, printSymbol, words, locale, minor, compact, cashSteps }) */
export function configureMoney(region){ R = region && region.symbol ? region : REGIONS.IN; }
export const moneyRegion = () => R;

/* What each output can print: the PDF's base-14 fonts (WinAnsi: Latin-1 here) and receipt printers (plain ASCII) */
const CHARSETS = { pdf: /^[\x20-\x7e\xa0-\xff]*$/, thermal: /^[\x20-\x7e]*$/ };
export const canPrint = (text, output) => !CHARSETS[output] || CHARSETS[output].test(String(text == null ? "" : text));
/* The symbol written before an amount on an output: ₹ on screen; Rs. in a PDF and on a receipt printer (India) */
export const currencySymbol = (output = "screen", region = R) => canPrint(region.symbol, output) ? region.symbol : region.printSymbol;
/* The symbol on its own, for a label or a button: "₹", "AED", "$" */
export const currencySign = () => R.symbol.trim();
/* A field label with the currency: moneyLabel("Selling price") → "Selling price (₹)" */
export const moneyLabel = label => `${label} (${currencySign()})`;
/* The currency named in a sentence: "rupees" ("Enter the budget in rupees.") */
export const currencyName = () => R.words.plain;

/* The figures of an amount as an output can print them (a locale may group with a thin or no-break space) */
const figures = (t, output) => output === "screen" ? t : t.replace(/[   ]/g, " ").replace(/’/g, "'");
/* An amount for an output (the screen by default):
     exact     paise when there are paise (₹1,048.95), whole rupees otherwise (₹1,049); without it, rounded to the rupee
     decimals  always that many decimals (2: 1,049.00, as the columns of a printed bill)
     symbol    false: the figures alone, for a column whose total carries the currency */
export function formatMoney(n, { output = "screen", exact = false, decimals = null, symbol = true } = {}){
  const sym = symbol ? currencySymbol(output) : "";
  if(!exact && decimals == null) return sym + figures(Math.round(n || 0).toLocaleString(R.locale), output);
  const p = Math.round((n || 0) * 100), v = Math.abs(p) / 100, d = decimals != null ? Math.max(0, Math.min(2, decimals)) : p % 100 ? 2 : 0;
  return (p < 0 ? (output === "screen" ? "−" : "-") : "") + sym + figures(v.toLocaleString(R.locale, { minimumFractionDigits: d, maximumFractionDigits: 2 }), output);
}
/* On screen: whole rupees (₹1,049) and to the paisa when there are paise (₹1,048.95) — for discounts, GST and round off */
export const inr = n => formatMoney(n);
export const inrx = n => formatMoney(n, { exact: true });
export const r1=x=>{const v=Math.round(x*10)/10;return v%1===0?v.toFixed(0):v.toFixed(1)};
export function inrShort(n){n=Math.round(n||0);return R.symbol+compactParts(n,R)}
export const f2=v=>Math.round(v*10)/10;
/* A count or plain number written the region's way (5,000; 1,00,000 in India) */
export const numberText = n => (+n || 0).toLocaleString(R.locale);

/* Text for an output that can't print every currency symbol: each symbol it can't print becomes its region's plain form
   ("Discount ₹50" → "Discount Rs.50" in a PDF or on a receipt printer). The shop's own region first, then the others; the
   output's own writer deals with any other character it can't print. */
export function printText(text, output){
  let s = String(text == null ? "" : text);
  if(!CHARSETS[output]) return s;
  for(const r of new Set([R, ...Object.values(REGIONS)])) if(!canPrint(r.symbol, output) && s.includes(r.symbol)) s = s.split(r.symbol).join(r.printSymbol);
  return s;
}

/* How an amount in the shop's currency may be marked when it is typed or pasted: its symbol, plain form and code, longest
   first ("Rs.", "INR", "Rs", "₹" in India; "AED" in the UAE; "GBP", "£" in the UK) */
export function currencyMarks(region = R){
  const m = [region.symbol, region.printSymbol, region.currency].map(x => String(x || "").trim()).filter(Boolean);
  m.slice().forEach(x => { if(/\w\.$/.test(x)) m.push(x.slice(0, -1)); });
  return [...new Set(m)].sort((a, b) => b.length - a.length);
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/* The marks as a regular expression source, for case-insensitive matching: a mark in letters is a word of its own
   ("Rs 499", "Rs499" and "INR 499" — never the "rs" in "Mrs") */
export const currencyMarkSource = (region = R) => "(?:" + currencyMarks(region).map(m => (/^\w/.test(m) ? "\\b" : "") + reEsc(m) + (/[a-z]$/i.test(m) ? "(?![a-z])" : "")).join("|") + ")";
/* Typed money without its currency mark, grouping commas and spaces: "₹1,099.00" → "1099.00", "Rs. 12.5" → "12.5".
   Another currency's mark stays, so the text isn't taken for a number. */
export const stripMoney = (text, region = R) => String(text == null ? "" : text).replace(new RegExp(currencyMarkSource(region), "gi"), "").replace(/[,\s]/g, "");

// Where the shop is: its currency, how money, numbers and dates are written, and how its phone numbers are dialled from
// abroad. The app reads these from here (money.js and dates.js are configured from the shop's settings.region; India by
// default), so another country is an entry in REGIONS — not a search through the app. Pure.
//   symbol       the currency as the app writes it before an amount (₹)
//   printSymbol  the same in plain ASCII, for outputs that can't print the symbol: the PDF's built-in fonts (WinAnsi has £
//                and $, not ₹) and receipt printers (ASCII only). money.js decides per output which one is written.
//   words        the currency in words: amounts in words on documents ("Rupees … and … Paise Only") and in sentences
//                ("Enter the budget in rupees.")
//   compact      the numbering: "indian" (thousand, lakh, crore) or "international" (thousand, million, billion), for short
//                money and amounts in words
//   cashSteps    the round sums a customer is likely to hand over (quick cash on the payment screen)
// What is still India-only and would come with another country: tax (GST, e-invoice, e-way bills: tax "gst"), UPI (an
// Indian payment system, always in INR), the messages the send-receipt and receipt Edge Functions write (₹), and the money
// core's hundredths and whole-unit round off (domain/sales/paise.js, checkout-totals.js: every currency here has 2 decimals).
const words = (major, minor, plain) => Object.freeze({ major, minor, plain });
export const REGIONS = Object.freeze({
  IN: Object.freeze({ code: "IN", name: "India", currency: "INR", symbol: "₹", printSymbol: "Rs.", words: words("Rupees", "Paise", "rupees"), minor: 2, locale: "en-IN", phoneCode: "91", phoneDigits: 10, compact: "indian", cashSteps: Object.freeze([100, 500, 2000]), tax: "gst" }),
  AE: Object.freeze({ code: "AE", name: "United Arab Emirates", currency: "AED", symbol: "AED ", printSymbol: "AED ", words: words("Dirhams", "Fils", "dirhams"), minor: 2, locale: "en-AE", phoneCode: "971", phoneDigits: 9, compact: "international", cashSteps: Object.freeze([10, 50, 100]), tax: "vat" }),
  GB: Object.freeze({ code: "GB", name: "United Kingdom", currency: "GBP", symbol: "£", printSymbol: "GBP ", words: words("Pounds", "Pence", "pounds"), minor: 2, locale: "en-GB", phoneCode: "44", phoneDigits: 10, compact: "international", cashSteps: Object.freeze([5, 20, 50]), tax: "vat" }),
  US: Object.freeze({ code: "US", name: "United States", currency: "USD", symbol: "$", printSymbol: "$", words: words("Dollars", "Cents", "dollars"), minor: 2, locale: "en-US", phoneCode: "1", phoneDigits: 10, compact: "international", cashSteps: Object.freeze([5, 20, 100]), tax: "sales" }),
  SG: Object.freeze({ code: "SG", name: "Singapore", currency: "SGD", symbol: "S$", printSymbol: "S$", words: words("Singapore Dollars", "Cents", "dollars"), minor: 2, locale: "en-SG", phoneCode: "65", phoneDigits: 8, compact: "international", cashSteps: Object.freeze([5, 10, 50]), tax: "gst-sg" }),
});
export const DEFAULT_REGION = "IN";
export const regionOf = code => REGIONS[String(code || "").toUpperCase()] || REGIONS[DEFAULT_REGION];

/* A phone number as WhatsApp and SMS want it: the country's code and the number, digits only ("" when it can't be one).
   A national number (with its leading 0, or without it) gets the country's code; a longer one is taken as international. */
export function phoneDigits(raw, region = REGIONS.IN){
  let d = String(raw == null ? "" : raw).replace(/\D/g, "");
  const n = region.phoneDigits, cc = region.phoneCode;
  if(d.length === n + 1 && d[0] === "0") d = d.slice(1);
  if(d.length === n) return cc + d;
  return d.length > n ? d : "";
}
/* Short money for charts: lakh and crore in India (₹1.2L, ₹3Cr), thousand / million / billion elsewhere ($1.2M) */
export function compactParts(n, region = REGIONS.IN){
  const a = Math.abs(n), r1 = x => { const v = Math.round(x * 10) / 10; return v % 1 === 0 ? v.toFixed(0) : v.toFixed(1); };
  const steps = region.compact === "indian" ? [[1e7, "Cr"], [1e5, "L"], [1e3, "k"]] : [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for(const [v, s] of steps) if(a >= v) return r1(n / v) + s;
  return String(n);
}

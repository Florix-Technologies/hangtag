// The shop's document templates (Settings → Bills & Documents → Templates): one look for every A4 document — tax invoice,
// bill, quotation, sales order, delivery challan, credit note, purchase order. A template (Standard, Classic, Modern,
// Compact), an accent colour, whether GST details are shown, terms, a signature line, the bank or UPI details to print, and
// whether the authorised signature and the company stamp (pictures, uploaded in the same place) are printed. The templates
// are the shop's own layouts for GST invoices (the details rule 46 asks for), not forms issued by the government. The 80 mm
// receipt keeps its own thermal layout. Pure.

export const DOC_TEMPLATES = [
  { key: "standard", label: "Standard", hint: "Plain and clear: white space and thin rules" },
  { key: "classic", label: "Classic", hint: "Formal: boxed details, every line ruled" },
  { key: "modern", label: "Modern", hint: "A band of your colour over a clean table" },
  { key: "compact", label: "Compact", hint: "Dense: more lines on each page" },
];
export const DOC_TEMPLATE_KEYS = DOC_TEMPLATES.map(t => t.key);
/* A template saved under an earlier name */
const RENAMED = { minimal: "standard" };
/* Accent colours that print well and read well on white (the template's titles, rules and table head) */
export const DOC_ACCENTS = [
  { key: "#1D5BBF", label: "Blue" }, { key: "#111420", label: "Ink" }, { key: "#0B6B35", label: "Green" },
  { key: "#8A1C3B", label: "Maroon" }, { key: "#0E6E7A", label: "Teal" }, { key: "#B4481D", label: "Rust" },
];
export const DOC_DEFAULTS = Object.freeze({ docTpl: "modern", docAccent: "#1D5BBF", docGst: true, docTerms: "", docSign: "", docBank: "", docSignImg: true, docStampImg: true });
const HEX = /^#[0-9A-Fa-f]{6}$/;
const many = (v, max) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, max + 1);
const tplKey = k => DOC_TEMPLATE_KEYS.includes(k) ? k : RENAMED[k] || "";
const flag = v => v !== false && v !== "false" && v !== 0 && v !== "0";

/* The document settings in force (the shop's choices over the defaults). signImg / stampImg: print the uploaded picture
   (when there is one) */
export function docSettingsOf(settings){
  const s = settings || {};
  return {
    template: tplKey(s.docTpl) || DOC_DEFAULTS.docTpl,
    accent: HEX.test(String(s.docAccent || "")) ? s.docAccent : DOC_DEFAULTS.docAccent,
    showGst: s.docGst !== false,
    terms: String(s.docTerms || ""), signature: String(s.docSign || ""), bank: String(s.docBank || ""),
    signImg: s.docSignImg !== false, stampImg: s.docStampImg !== false,
  };
}
/* input: { docTpl, docAccent, docGst, docTerms, docSign, docBank, docSignImg, docStampImg } as typed → { patch } or { error, field } */
export function checkDocSettings(input){
  const x = input || {}, tpl = tplKey(x.docTpl);
  if(!tpl) return { error: "Choose a template.", field: "docTpl" };
  if(!HEX.test(String(x.docAccent || ""))) return { error: "Choose an accent colour.", field: "docAccent" };
  const terms = many(x.docTerms, 1200), sign = many(x.docSign, 120), bank = many(x.docBank, 400);
  if(terms.length > 1200) return { error: "Terms can be at most 1,200 characters.", field: "docTerms" };
  if(sign.length > 120) return { error: "The signature line can be at most 120 characters.", field: "docSign" };
  if(bank.length > 400) return { error: "Bank and payment details can be at most 400 characters.", field: "docBank" };
  return { patch: { docTpl: tpl, docAccent: x.docAccent, docGst: flag(x.docGst), docTerms: terms, docSign: sign, docBank: bank,
    docSignImg: x.docSignImg === undefined ? true : flag(x.docSignImg), docStampImg: x.docStampImg === undefined ? true : flag(x.docStampImg) } };
}
/* The two pictures a document may carry besides the logo */
export const DOC_IMAGE_KINDS = Object.freeze({ signature: "Authorised signature", stamp: "Company stamp" });
/* The pictures as kept on a device or read back from a backup: only picture data URLs, anything else is dropped */
export const docImagesOf = v => { const x = v && typeof v === "object" ? v : {}, ok = d => typeof d === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(d) ? d : "";
  return { signature: ok(x.signature), stamp: ok(x.stamp) }; };

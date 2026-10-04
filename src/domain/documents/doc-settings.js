// The shop's document templates (Settings → Billing & Documents → Templates): one look for every A4 document — tax invoice,
// bill, quotation, sales order, delivery challan, credit note, purchase order. A template (Modern, Classic, Minimal), an
// accent colour, whether GST details are shown, terms, a signature line and the bank or UPI details to print. The 80 mm
// receipt keeps its own compact layout (it is the "Compact / thermal" template). Pure.

export const DOC_TEMPLATES = [
  { key: "modern", label: "Modern", hint: "A band of your colour over a clean table" },
  { key: "classic", label: "Classic", hint: "Formal: boxed details, every line ruled" },
  { key: "minimal", label: "Minimal", hint: "Quiet: white space and thin rules" },
];
export const DOC_TEMPLATE_KEYS = DOC_TEMPLATES.map(t => t.key);
/* Accent colours that print well and read well on white (the template's titles, rules and table head) */
export const DOC_ACCENTS = [
  { key: "#1D5BBF", label: "Blue" }, { key: "#111420", label: "Ink" }, { key: "#0B6B35", label: "Green" },
  { key: "#8A1C3B", label: "Maroon" }, { key: "#0E6E7A", label: "Teal" }, { key: "#B4481D", label: "Rust" },
];
export const DOC_DEFAULTS = Object.freeze({ docTpl: "modern", docAccent: "#1D5BBF", docGst: true, docTerms: "", docSign: "", docBank: "" });
const HEX = /^#[0-9A-Fa-f]{6}$/;
const many = (v, max) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, max + 1);

/* The document settings in force (the shop's choices over the defaults) */
export function docSettingsOf(settings){
  const s = settings || {};
  return {
    template: DOC_TEMPLATE_KEYS.includes(s.docTpl) ? s.docTpl : DOC_DEFAULTS.docTpl,
    accent: HEX.test(String(s.docAccent || "")) ? s.docAccent : DOC_DEFAULTS.docAccent,
    showGst: s.docGst !== false,
    terms: String(s.docTerms || ""), signature: String(s.docSign || ""), bank: String(s.docBank || ""),
  };
}
/* input: { docTpl, docAccent, docGst, docTerms, docSign, docBank } as typed → { patch } or { error, field } */
export function checkDocSettings(input){
  const x = input || {};
  if(!DOC_TEMPLATE_KEYS.includes(x.docTpl)) return { error: "Choose a template.", field: "docTpl" };
  if(!HEX.test(String(x.docAccent || ""))) return { error: "Choose an accent colour.", field: "docAccent" };
  const terms = many(x.docTerms, 1200), sign = many(x.docSign, 120), bank = many(x.docBank, 400);
  if(terms.length > 1200) return { error: "Terms can be at most 1,200 characters.", field: "docTerms" };
  if(sign.length > 120) return { error: "The signature line can be at most 120 characters.", field: "docSign" };
  if(bank.length > 400) return { error: "Bank and payment details can be at most 400 characters.", field: "docBank" };
  return { patch: { docTpl: x.docTpl, docAccent: x.docAccent, docGst: x.docGst !== false && x.docGst !== "false", docTerms: terms, docSign: sign, docBank: bank } };
}

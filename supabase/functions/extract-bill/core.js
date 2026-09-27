// Supplier bill extraction: request building, validation and normalisation. Plain ES module with no Deno or Node APIs,
// so the unit tests import it directly (tests/unit/extract-bill.test.mjs). The provider (providers/claude.js) and the HTTP
// wrapper (index.ts) stay thin.

export const MAX_BYTES = 15 * 1024 * 1024;
export const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
export const DEFAULT_MODEL = "claude-opus-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

/* What the model must return. Every field is present; unknown values are null (never guessed). */
export const EXTRACTION_SCHEMA = obj({
  supplier: obj({ name: nullable("string"), gstin: nullable("string") }),
  invoice: obj({ number: nullable("string"), date: nullable("string") }),
  currency: nullable("string"),
  lines: {
    type: "array",
    items: obj({
      name: nullable("string"),
      description: nullable("string"),
      brand: nullable("string"),
      options: { type: "array", items: obj({ name: { type: "string" }, value: { type: "string" } }) },
      quantity: nullable("number"),
      unit_price: nullable("number"),
      total_price: nullable("number"),
      mrp: nullable("number"),
      sku: nullable("string"),
      barcode: nullable("string"),
      hsn: nullable("string"),
      gst_rate: nullable("number"),
      tax_amount: nullable("number"),
      confidence: { type: "number" },
      notes: nullable("string"),
    }),
  },
  warnings: { type: "array", items: { type: "string" } },
});

export const SYSTEM_PROMPT = `You read supplier purchase bills (tax invoices, delivery challans, estimates) for a small Indian retail shop. The shop uses what you extract to add stock it received, after a person reviews every line, so accuracy matters more than completeness.

Extract every product line on the bill: the goods the shop received. Skip lines that are not products (freight, packing, round-off, discounts, sub-totals, tax summaries, totals) and mention each skipped line in warnings.

Rules:
- Never invent or infer a value that is not on the bill. If a field is not shown, or you cannot read it, return null. An empty list of options is correct when the bill shows none.
- Split the product name from option values only when the bill clearly shows them, for example separate Colour / Size / Storage columns, or an obvious pattern such as "Dress Black M". Use the bill's own words for option names (Colour, Size, Storage, RAM, Weight, Pack size, Model, Shade, Material, Length…) and values. When unsure, keep the text in the name.
- quantity is the number of units received on that line. If the bill gives packs or dozens and the unit count is not stated, give the quantity as printed and explain in notes.
- unit_price is the supplier's price per unit before tax when the bill shows it; total_price is the line amount as printed. Do not compute a missing price.
- mrp is the printed maximum retail price, if any.
- hsn is the HSN/SAC code exactly as printed (digits only). gst_rate is the tax percentage for the line (for example 5 or 12); if CGST and SGST are shown separately, add them. tax_amount is the line's tax if printed.
- sku and barcode only when printed for that line (article no., style no., item code, EAN/UPC).
- Numbers: plain numbers without currency symbols or thousands separators.
- invoice.date as YYYY-MM-DD when the date is readable, otherwise null. supplier.gstin exactly as printed.
- confidence (0 to 1) is how sure you are that the whole line is read correctly. Use a low value for blurry, handwritten, cut-off or ambiguous lines, and say why in notes.
- currency: "INR" for rupee bills, otherwise the currency shown, or null.`;

/* Checks the request body; returns { ok:true, data, mimeType, fileName, fileHash } or { ok:false, status, error, message } */
export function validateUpload(body) {
  if (!body || typeof body !== "object") return fail(400, "bad_request", "Send the bill as JSON.");
  const mimeType = String(body.mime_type || "").toLowerCase().trim();
  const data = typeof body.data === "string" ? body.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "") : "";
  if (!data) return fail(400, "bad_request", "The bill file is missing.");
  if (!ACCEPTED_TYPES.includes(mimeType)) return fail(415, "unsupported_type", "Use a PDF, JPG, PNG or WebP file.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail(400, "bad_request", "The bill file isn't valid base64.");
  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > MAX_BYTES) return fail(413, "too_large", "The file is larger than 15 MB. Take a photo of the bill or split the PDF.");
  return { ok: true, data, mimeType, fileName: String(body.file_name || "bill").slice(0, 200), fileHash: String(body.file_hash || "").slice(0, 128) };
}
const fail = (status, error, message) => ({ ok: false, status, error, message });

/* The user turn: the document (PDF) or picture, then the instruction */
export function buildUserContent({ data, mimeType, fileName }) {
  const file = mimeType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: mimeType, data } };
  return [file, { type: "text", text: `Extract the product lines from this supplier bill (file: ${String(fileName || "bill").slice(0, 120)}).` }];
}

/* Parameters for client.beta.messages.stream(): JSON output constrained to EXTRACTION_SCHEMA, adaptive thinking, and the
   server-side refusal fallback (a declined request is re-run on Anthropic's recommended fallback model) */
export function buildRequest({ model, data, mimeType, fileName }) {
  return {
    model: model || DEFAULT_MODEL,
    max_tokens: 64000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserContent({ data, mimeType, fileName }) }],
  };
}

/* The final message → { ok:true, result } or { ok:false, status, error, message } */
export function parseModelResponse(message, meta = {}) {
  if (!message) return fail(502, "no_response", "The reading service didn't answer. Try again.");
  if (message.stop_reason === "refusal") return fail(422, "refused", "This file couldn't be read as a supplier bill.");
  if (message.stop_reason === "max_tokens") return fail(422, "truncated", "The bill is too long to read in one go. Split it into smaller files.");
  const text = (message.content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("");
  let raw;
  try { raw = JSON.parse(text); } catch { return fail(502, "bad_output", "The bill couldn't be read. Try a clearer photo."); }
  return { ok: true, result: normalizeExtraction(raw, { provider: meta.provider, model: message.model || meta.model }) };
}

/* ---------- normalisation ---------- */
const str = (v, max = 300) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
/* "₹1,099.00" → 1099, "5%" → 5, "Rs. 12.5" → 12.5; anything unreadable → null */
export function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[₹,%\s]|rs\.?|inr/gi, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const date = (v) => {
  const s = str(v, 20);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
};

/* The response contract: trimmed strings, numbers parsed, confidence 0..1, empty lines dropped, nothing invented */
export function normalizeExtraction(raw, meta = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const warnings = (Array.isArray(r.warnings) ? r.warnings : []).map((w) => str(w, 300)).filter(Boolean);
  const lines = [];
  (Array.isArray(r.lines) ? r.lines : []).forEach((l, i) => {
    if (!l || typeof l !== "object") return;
    const options = (Array.isArray(l.options) ? l.options : [])
      .map((o) => ({ name: str(o && o.name, 24), value: str(o && o.value, 40) })).filter((o) => o.name && o.value);
    const line = {
      name: str(l.name, 120), description: str(l.description, 300), brand: str(l.brand, 60), options,
      quantity: toNumber(l.quantity), unit_price: toNumber(l.unit_price), total_price: toNumber(l.total_price), mrp: toNumber(l.mrp),
      sku: str(l.sku, 40), barcode: str(l.barcode, 64), hsn: str(l.hsn, 8) && String(l.hsn).replace(/\D/g, "").slice(0, 8) || null,
      gst_rate: toNumber(l.gst_rate), tax_amount: toNumber(l.tax_amount),
      confidence: Math.min(1, Math.max(0, toNumber(l.confidence) ?? 0)), notes: str(l.notes, 300),
    };
    const empty = !line.name && !line.description && !line.sku && !line.barcode && line.quantity == null && line.unit_price == null && line.total_price == null;
    if (empty) return;
    if (line.quantity != null && !Number.isInteger(line.quantity)) warnings.push(`Line ${i + 1}: quantity ${line.quantity} is not a whole number.`);
    lines.push(line);
  });
  return {
    ok: true, provider: meta.provider || null, model: meta.model || null,
    supplier: { name: str(r.supplier && r.supplier.name, 120), gstin: str(r.supplier && r.supplier.gstin, 15) },
    invoice: { number: str(r.invoice && r.invoice.number, 40), date: date(r.invoice && r.invoice.date) },
    currency: str(r.currency, 8) || "INR", lines, warnings,
  };
}

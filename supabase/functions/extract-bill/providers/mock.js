// Mock provider (EXTRACT_PROVIDER=mock): a fixed, realistic extraction for trying the app without an API key, and for tests.
import { normalizeExtraction } from "../core.js";

export const MOCK_EXTRACTION = {
  supplier: { name: "Ravi Textiles", gstin: "27ABCDE1234F1Z5" },
  invoice: { number: "INV-1042", date: "2026-09-20" },
  currency: "INR",
  lines: [
    { name: "Dress", description: null, brand: "Aura", options: [{ name: "Colour", value: "Black" }, { name: "Size", value: "M" }], quantity: 5, unit_price: 600, total_price: 3000, mrp: 999, sku: null, barcode: null, hsn: "6204", gst_rate: 5, tax_amount: 150, confidence: 0.95, notes: null },
    { name: "Dress", description: null, brand: "Aura", options: [{ name: "Colour", value: "Black" }, { name: "Size", value: "L" }], quantity: 7, unit_price: 650, total_price: 4550, mrp: 1099, sku: null, barcode: null, hsn: "6204", gst_rate: 5, tax_amount: 227.5, confidence: 0.93, notes: null },
    { name: "Dress", description: null, brand: "Aura", options: [{ name: "Colour", value: "White" }, { name: "Size", value: "M" }], quantity: 6, unit_price: 580, total_price: 3480, mrp: 949, sku: null, barcode: null, hsn: "6204", gst_rate: 5, tax_amount: 174, confidence: 0.62, notes: "Colour partly hidden by a fold." },
    { name: "Tote Bag", description: "Canvas", brand: null, options: [], quantity: 10, unit_price: 180, total_price: 1800, mrp: null, sku: null, barcode: null, hsn: null, gst_rate: 12, tax_amount: 216, confidence: 0.9, notes: null },
  ],
  warnings: ["Skipped: Freight charges ₹200", "Skipped: Round off ₹0.50"],
};

export function createMockProvider() {
  return {
    name: "mock",
    model: "mock",
    async extract() { return { ok: true, result: normalizeExtraction(MOCK_EXTRACTION, { provider: "mock", model: "mock" }) }; },
  };
}

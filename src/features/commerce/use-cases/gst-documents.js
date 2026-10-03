// E-invoice and e-way bill readiness for a saved bill (domain/gst/einvoice.js, domain/gst/eway.js). Hangtag prepares and
// checks the standard JSON, asks only for what is missing, keeps the prepared record (ready / waiting to send) and exports
// the JSON. It never makes up an IRN or e-way bill number: those come only from a provider (the database refuses them from
// the app). Changing the shop's GST details is manage_settings, a customer's create_sale, a product's manage_products.
import { einvoicePayload, einvoiceState } from '../../../domain/gst/einvoice.js';
import { cleanTransport, ewayPayload, ewayState } from '../../../domain/gst/eway.js';
import { validGstin } from '../../../shared/validation/gstin.js';
import { store } from '../../../shared/state/store.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { use } from '../../../shared/di/services.js';
import { can, denied } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { D } from '../../inventory/services/ledger.js';
import { prod } from '../../products/services/catalog.js';
import { customerRepository } from '../../customers/repositories/customer-repository.js';
import { productRepository } from '../../products/repositories/product-repository.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { bizRepository } from '../repositories/biz-repository.js';

const upload = () => { renderSync(); flushSbQueue(); };
export const usesEinvoice = () => hasCap("uses_einvoice");
export const usesEway = () => hasCap("uses_eway");
const ctxFor = s => ({ shop: store.profile || {}, settings: store.settings || {}, customer: s && s.cust && s.cust.id ? store.customers[s.cust.id] || s.cust : s && s.cust || {}, products: id => prod(id) });
/* The bill's e-invoice now → { state, missing, problems, payload?, record? } (null when the shop doesn't use e-invoices) */
export function einvoiceOf(saleId){
  const s = D().saleById[saleId]; if(!s || !usesEinvoice()) return null;
  return einvoiceState(s, ctxFor(s), bizRepository().get("ei", saleId));
}
export function ewayOf(saleId){
  const s = D().saleById[saleId]; if(!s || !usesEway()) return null;
  return ewayState(s, ctxFor(s), bizRepository().get("ew", saleId));
}
/* Keeps the prepared e-invoice (ready, or waiting to send once a provider is connected) → { record } or { error } */
export function keepEinvoice(saleId, status = "ready"){
  const no = denied(["create_sale", "view_reports"], "prepare e-invoices"); if(no) return no;
  const s = D().saleById[saleId], st = einvoiceOf(saleId); if(!s || !st) return { error: "That bill isn't on this device." };
  if(st.state !== "ready" && !(st.state === "pending" && status === "ready")) return { error: st.missing.length ? "Fill in the missing details first." : st.problems[0] || "This bill doesn't need an e-invoice." };
  const record = bizRepository().save("ei", { id: saleId, saleId, status: status === "pending" ? "pending" : "ready", payload: st.payload || einvoicePayload(s, ctxFor(s)).payload, t: Date.now(), dev: store.dev });
  upload(); return { record };
}
/* The transport of the bill's e-way bill (only the fields asked) → { record, state } or { error } */
export function saveTransport(saleId, transport, status){
  const no = denied(["create_sale", "view_reports"], "prepare e-way bills"); if(no) return no;
  const s = D().saleById[saleId]; if(!s || !usesEway()) return { error: "That bill isn't on this device." };
  const prev = bizRepository().get("ew", saleId);
  const T = cleanTransport({ ...(prev && prev.transport || {}), ...(transport || {}) });
  const st = ewayState(s, { ...ctxFor(s), transport: T }, null);
  if(status && st.state !== "ready") return { error: st.missing.length ? "Fill in: " + st.missing.map(m => m.label).join(", ") + "." : st.problems[0] };
  const record = bizRepository().save("ew", { id: saleId, saleId, status: status === "pending" ? "pending" : "ready", transport: T, payload: ewayPayload(s, { ...ctxFor(s), transport: T }).payload, t: Date.now(), dev: store.dev });
  upload(); return { record, state: ewayState(s, ctxFor(s), record) };
}
/* The missing details typed on the readiness sheet, each saved where it belongs: the shop's GST details (settings), the
   customer (GSTIN, address) or a product (HSN). values: { seller_pin, seller_name, seller_address, buyer_gstin, buyer_address,
   buyer_city, buyer_pin, buyer_state, "hsn:<product>" } → { ok } or { error } */
export function fillDetails(saleId, values){
  const s = D().saleById[saleId]; if(!s) return { error: "That bill isn't on this device." };
  const v = values || {}, has = k => v[k] != null && String(v[k]).trim() !== "";
  if(["seller_pin", "seller_name"].some(has)){
    if(!can("manage_settings")) return { error: "Ask the owner to add the shop's GST details (Settings → Selling → GST documents)." };
    if(has("seller_pin") && !/^[1-9][0-9]{5}$/.test(String(v.seller_pin).trim())) return { error: "A PIN code has 6 digits." };
    store.settings = { ...store.settings, einv: { ...(store.settings.einv || {}), ...(has("seller_pin") ? { pin: String(v.seller_pin).trim() } : {}), ...(has("seller_name") ? { legalName: String(v.seller_name).trim().slice(0, 100) } : {}) } };
    saveSettings(); enqueue({ type: "settings" });
  }
  if(["buyer_gstin", "buyer_address", "buyer_city", "buyer_pin", "buyer_state"].some(has)){
    const id = s.cust && s.cust.id, c = id && customerRepository().get(id);
    if(!c) return { error: "Add the customer to Customers first: their GSTIN and address are kept there." };
    if(!can("create_sale") && !can("create_order")) return { error: "Your role can't change customers." };
    const g = has("buyer_gstin") ? String(v.buyer_gstin).toUpperCase().replace(/\s/g, "") : c.gstin;
    if(has("buyer_gstin") && !validGstin(g)) return { error: "A GSTIN has 15 letters and digits, like 27ABCDE1234F1Z5." };
    if(has("buyer_pin") && !/^[1-9][0-9]{5}$/.test(String(v.buyer_pin).trim())) return { error: "A PIN code has 6 digits." };
    const a = c.addr || {};
    customerRepository().save({ ...c, gstin: g || "", ...(g ? { type: "business" } : {}), addr: { line: has("buyer_address") ? String(v.buyer_address).trim().slice(0, 200) : a.line || "", city: has("buyer_city") ? String(v.buyer_city).trim().slice(0, 60) : a.city || "",
      pin: has("buyer_pin") ? String(v.buyer_pin).trim() : a.pin || "", state: has("buyer_state") ? String(v.buyer_state).trim().slice(0, 60) : a.state || "" } });
  }
  const hsn = Object.keys(v).filter(k => k.startsWith("hsn:") && has(k));
  if(hsn.length){
    if(!can("manage_products")) return { error: "Ask someone who edits products to add the HSN codes." };
    for(const k of hsn){
      const code = String(v[k]).replace(/\s/g, ""), p = productRepository().get(k.slice(4));
      if(!/^[0-9]{4,8}$/.test(code)) return { error: "An HSN code has 4 to 8 digits." };
      if(p) productRepository().save({ product: { ...p, hsn: code }, isNew: false, renamed: false, newMoves: [], deletedVariantIds: [], image: undefined });
    }
  }
  upload(); return { ok: true };
}
/* The JSON file for the bill (e-invoice or e-way bill), downloaded on this device */
export async function exportJSON(saleId, what){
  const s = D().saleById[saleId]; if(!s) return { error: "That bill isn't on this device." };
  const st = what === "eway" ? ewayOf(saleId) : einvoiceOf(saleId); if(!st) return { error: "This shop doesn't prepare these yet." };
  const payload = st.payload || (st.record && st.record.payload);
  if(!payload) return { error: "Fill in the missing details first." };
  const name = `${what === "eway" ? "eway" : "einvoice"}-${String(s.no || s.id).replace(/[^A-Za-z0-9-]/g, "_")}.json`;
  const ok = await use("files").saveFile(name, JSON.stringify(what === "eway" ? { version: "1.0.0621", billLists: [payload] } : [payload], null, 2), "application/json");
  return ok ? { ok: true, name } : { error: "The file couldn't be saved." };
}
/* Settings → Selling → GST documents: { einvOn, b2bOnly, legalName, pin, ewayOn, threshold } */
export function saveGstSettings(x){
  const no = denied("manage_settings", "change GST settings"); if(no) return no;
  const pin = String(x.pin || "").trim();
  if(pin && !/^[1-9][0-9]{5}$/.test(pin)) return { error: "A PIN code has 6 digits.", field: "pin" };
  const th = x.threshold === "" || x.threshold == null ? 50000 : +x.threshold;
  if(!(Number.isFinite(th) && th >= 0)) return { error: "Enter the e-way bill limit in rupees.", field: "threshold" };
  store.settings = { ...store.settings, einv: { ...(store.settings.einv || {}), on: !!x.einvOn, b2bOnly: x.b2bOnly !== false, legalName: String(x.legalName || "").trim().slice(0, 100), pin },
    eway: { ...(store.settings.eway || {}), on: !!x.ewayOn, threshold: th } };
  saveSettings(); enqueue({ type: "settings" }); upload();
  return { ok: true };
}

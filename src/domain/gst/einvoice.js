// E-invoice readiness. Hangtag does NOT talk to the GST portal (IRP) or hold GST credentials: it turns a saved bill into the
// standard e-invoice JSON (schema 1.1 field names), checks it, and says in plain words what is still missing — usually
// only the buyer's GSTIN, address or PIN code. The flow is
//   saved bill → payload → checks → (later) a provider adapter → IRP → IRN
// The IRN, acknowledgement number/date and signed QR are only ever stored when a provider returns them (the database
// refuses them from the app: supabase/schema.sql section 3r); Hangtag never makes one up.
// Whether a bill needs an e-invoice is the shop's setting (settings.einv: { on, b2bOnly }), because the rules depend on the
// business's turnover and change over time; by default only business-to-business bills of a shop that switched it on.
// Pure; works on the saved bill (its lines already carry taxable value, GST split and HSN).
import { gstinState, stateCode, stateName } from '../sales/gst.js';
import { unitOf } from '../catalog/units.js';
import { validGstin } from '../../shared/validation/gstin.js';

export const EINV_STATUSES = ["not_required", "ready", "pending", "generated", "failed", "cancelled"];
export const EINV_LABELS = { not_required: "Not needed", ready: "Ready", pending: "Waiting to send", generated: "Generated", failed: "Failed", cancelled: "Cancelled", needs: "Needs details" };
export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
const r2 = n => Math.round((+n || 0) * 100) / 100;
const r3 = n => Math.round((+n || 0) * 1000) / 1000;
const txt = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, max);
const PIN_RE = /^[1-9][0-9]{5}$/;
/* "yyyy-mm-dd" or a time in ms → "dd/mm/yyyy" (India time) */
export function ddmmyyyy(t){
  const d = typeof t === "number" ? new Date(t + 19800000) : new Date(String(t) + "T00:00:00Z");
  if(isNaN(d)) return "";
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
/* An e-invoice doc number: up to 16 characters, letters/digits and / -, not starting with 0 / - */
export const docNoOk = no => /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/.test(String(no || ""));
/* Does this bill need an e-invoice? settings.einv: { on, b2bOnly (default true) } */
export function einvoiceApplies(sale, settings){
  const e = settings && settings.einv || {};
  if(!e.on || !sale || sale.void || (sale.kind && sale.kind !== "sale")) return false;
  if(!(settings && settings.taxOn)) return false;
  const b2b = !!(sale.cust && validGstin(String(sale.cust.gstin || "").toUpperCase()));
  return e.b2bOnly === false ? true : b2b;
}
/* Where each detail comes from, so the screen asks only for what is missing: shop (profile + settings.einv), customer
   (Customers) or product (HSN). address: { line, city, pin, state } */
const addrOf = (a, fallbackCity, fallbackState) => ({ line: txt(a && a.line, 100), city: txt(a && a.city || fallbackCity, 50), pin: txt(a && a.pin, 6), state: txt(a && a.state || fallbackState, 60) });
/* The e-invoice payload of a saved bill.
   ctx: { shop (profile: shop_name, gstin, address, city, state, phone), settings (einv: { legalName, pin }), customer (the saved
   customer: name, gstin, phone, email, addr), products (id → product, for HSN of lines that have none) }
   → { payload, missing: [{ key, label, where, ref? }], problems: [text] } */
export function einvoicePayload(sale, ctx){
  const c = ctx || {}, shop = c.shop || {}, E = c.settings && c.settings.einv || {}, cust = c.customer || sale.cust || {};
  const missing = [], problems = [], need = (key, label, where, ref) => missing.push({ key, label, where, ...(ref ? { ref } : {}) });
  const sGstin = String(shop.gstin || "").toUpperCase(), bGstin = String(cust.gstin || (sale.cust && sale.cust.gstin) || "").toUpperCase();
  const sAddr = addrOf({ line: shop.address, pin: E.pin }, shop.city, shop.state), bAddr = addrOf(cust.addr, "", "");
  const sState = gstinState(sGstin) || stateCode(shop.state), bState = gstinState(bGstin) || stateCode(bAddr.state);
  if(!validGstin(sGstin)) need("seller_gstin", "Your shop's GSTIN", "shop");
  if(!txt(E.legalName || shop.shop_name, 100)) need("seller_name", "Your business's legal name", "shop");
  if(sAddr.line.length < 3) need("seller_address", "Your shop's address", "shop");
  if(!sAddr.city) need("seller_city", "Your shop's city", "shop");
  if(!PIN_RE.test(sAddr.pin)) need("seller_pin", "Your shop's PIN code", "shop");
  const b2b = validGstin(bGstin);
  if(!b2b) need("buyer_gstin", "Buyer GSTIN", "customer", cust.id);
  if(!txt(cust.name || (sale.cust && sale.cust.name), 100)) need("buyer_name", "Buyer's name", "customer", cust.id);
  if(bAddr.line.length < 3) need("buyer_address", "Buyer's address", "customer", cust.id);
  if(!bAddr.city) need("buyer_city", "Buyer's city", "customer", cust.id);
  if(!PIN_RE.test(bAddr.pin)) need("buyer_pin", "Buyer's PIN code", "customer", cust.id);
  if(!docNoOk(sale.no)) problems.push(`The bill number ${sale.no || ""} is longer than 16 characters or has other symbols. E-invoices need a shorter number series.`);
  const items = (sale.items || []).map((i, k) => {
    const p = c.products ? c.products(i.p) : null, hsn = String(i.hsn || (p && p.hsn) || "").replace(/\s/g, "");
    if(!/^[0-9]{4,8}$/.test(hsn)) need("hsn:" + i.p, `HSN code of ${i.n}`, "product", i.p);
    const rate = +i.gst || 0;
    if(!GST_RATES.includes(rate)) problems.push(`${i.n}: GST ${rate}% isn't a GST rate.`);
    const gross = r2((+i.q || 0) * (+i.price || 0)), disc = r2((+i.dAmt || 0) + (+i.bdAmt || 0)), taxable = r2(i.tx != null ? i.tx : gross - disc);
    return { SlNo: String(k + 1), PrdDesc: txt(i.n + (i.vl ? " " + i.vl : ""), 300), IsServc: "N", HsnCd: hsn, Barcde: i.sku ? txt(i.sku, 30) : null,
      Qty: r3(i.q), FreeQty: 0, Unit: unitOf(i.u).uqc || "OTH", UnitPrice: r2(i.price), TotAmt: gross, Discount: disc, PreTaxVal: taxable, AssAmt: taxable,
      GstRt: rate, IgstAmt: r2(i.igst), CgstAmt: r2(i.cgst), SgstAmt: r2(i.sgst), CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0,
      StateCesNonAdvlAmt: 0, OthChrg: 0, TotItemVal: r2(i.lt != null ? i.lt : taxable + (+i.cgst || 0) + (+i.sgst || 0) + (+i.igst || 0)) };
  });
  if(!items.length) problems.push("The bill has no lines.");
  const sum = k => r2(items.reduce((a, x) => a + x[k], 0));
  const payload = {
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: "B2B", RegRev: "N", EcmGstin: null, IgstOnIntra: "N" },
    DocDtls: { Typ: "INV", No: String(sale.no || ""), Dt: ddmmyyyy(sale.t) },
    SellerDtls: { Gstin: sGstin, LglNm: txt(E.legalName || shop.shop_name, 100), TrdNm: txt(shop.shop_name, 100), Addr1: sAddr.line, Addr2: null, Loc: sAddr.city,
      Pin: +sAddr.pin || null, Stcd: sState, Ph: String(shop.phone || "").replace(/\D/g, "").slice(-12) || null, Em: null },
    BuyerDtls: { Gstin: bGstin, LglNm: txt(cust.name || (sale.cust && sale.cust.name), 100), TrdNm: null, Pos: bState || (sale.gst && sale.gst.pos) || "", Addr1: bAddr.line, Addr2: null,
      Loc: bAddr.city, Pin: +bAddr.pin || null, Stcd: bState, Ph: String(cust.phone || "").replace(/\D/g, "").slice(-12) || null, Em: cust.email || null },
    ItemList: items,
    ValDtls: { AssVal: sum("AssAmt"), CgstVal: sum("CgstAmt"), SgstVal: sum("SgstAmt"), IgstVal: sum("IgstAmt"), CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0,
      RndOffAmt: r2(sale.roundOff), TotInvVal: r2(sale.total) },
  };
  // the money must add up the way the portal checks it
  const lines = r2(items.reduce((a, x) => a + x.TotItemVal, 0) + (+sale.roundOff || 0));
  if(items.length && Math.abs(lines - r2(sale.total)) > 0.5) problems.push("The lines don't add up to the bill total.");
  if(sState && bState && b2b){
    const inter = sState !== bState, hasIgst = items.some(x => x.IgstAmt > 0), hasCs = items.some(x => x.CgstAmt > 0 || x.SgstAmt > 0);
    if(inter && hasCs) problems.push(`The buyer is in ${stateName(bState)} but the bill charged CGST + SGST. Inter-state bills need IGST.`);
    if(!inter && hasIgst) problems.push("The buyer is in your state but the bill charged IGST.");
  }
  return { payload, missing, problems };
}
/* What the bill's e-invoice looks like right now → { state: "not_required" | "needs" | "ready" | stored status, missing, problems }
   stored: the record kept for the bill ({ status, irn, … }) or null */
export function einvoiceState(sale, ctx, stored){
  if(stored && ["pending", "generated", "failed", "cancelled"].includes(stored.status)) return { state: stored.status, missing: [], problems: [], record: stored };
  if(!einvoiceApplies(sale, ctx && ctx.settings)) return { state: "not_required", missing: [], problems: [] };
  const r = einvoicePayload(sale, ctx);
  return { state: r.missing.length || r.problems.length ? "needs" : "ready", missing: r.missing, problems: r.problems, payload: r.payload };
}
/* A record the app may keep (the provider's answer — IRN etc. — is never set here) */
export function einvoiceRecord(sale, payload, status){
  if(!["ready", "pending", "not_required"].includes(status)) return { error: "Only a provider can mark an e-invoice generated, failed or cancelled." };
  return { record: { id: sale.id, saleId: sale.id, status, payload, t: Date.now() } };
}

// E-way bill readiness. As with e-invoices (./einvoice.js), Hangtag does not connect to the e-way bill portal or keep GST
// credentials: it prepares the standard e-way bill JSON from the saved bill, the shop and the customer, checks it, and asks
// only for what it can't know — the transport (vehicle number, mode, distance or the transporter) and, when the goods go
// somewhere else than the customer's address, the delivery address.
//   bill (or a stock movement) → preparation → checks → payload → (later) a provider adapter → EWB number
// An EWB number, its date and validity are only stored when a provider returns them (the database refuses them from the
// app); Hangtag never pretends an e-way bill exists. When one is needed is the shop's setting (settings.eway: { on,
// threshold }), not a fixed rule, because the limits differ by state and change. Pure.
import { gstinState, stateCode } from '../sales/gst.js';
import { unitOf } from '../catalog/units.js';
import { validGstin } from '../../shared/validation/gstin.js';
import { ddmmyyyy, docNoOk } from './einvoice.js';

export const EWAY_STATUSES = ["not_required", "ready", "pending", "generated", "failed", "cancelled"];
export const EWAY_LABELS = { not_required: "Not needed", ready: "Ready", pending: "Waiting to send", generated: "Generated", failed: "Failed", cancelled: "Cancelled", needs: "Needs transport details" };
export const TRANSPORT_MODES = { road: { code: "1", label: "Road" }, rail: { code: "2", label: "Rail" }, air: { code: "3", label: "Air" }, ship: { code: "4", label: "Ship" } };
export const DEFAULT_THRESHOLD = 50000;
const r2 = n => Math.round((+n || 0) * 100) / 100;
const txt = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, max);
const PIN_RE = /^[1-9][0-9]{5}$/;
/* A vehicle registration number as typed ("mh 12 ab 1234" → "MH12AB1234"); temporary (TR…) and defence numbers pass too */
export const cleanVehicle = v => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const vehicleOk = v => /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(v) || /^TR[A-Z0-9]{6,13}$/.test(v) || /^[0-9]{2}[A-Z][0-9]{6}[A-Z]$/.test(v);
/* A transporter id is a GSTIN or a 15-character enrolment id */
export const transporterOk = id => /^[0-9]{2}[A-Z0-9]{13}$/.test(String(id || "").toUpperCase());

/* Does this bill need an e-way bill? settings.eway: { on, threshold (₹, default 50,000) } */
export function ewayApplies(sale, settings){
  const e = settings && settings.eway || {};
  if(!e.on || !sale || sale.void || (sale.kind && sale.kind !== "sale")) return false;
  const limit = Number.isFinite(+e.threshold) && +e.threshold >= 0 ? +e.threshold : DEFAULT_THRESHOLD;
  return r2(sale.total) >= limit;
}
/* The transport details as typed → cleaned: { mode, vehicle, docNo, docDate, distance, transporterId, transporterName, to? (delivery address) } */
export function cleanTransport(t){
  const x = t || {};
  return { mode: TRANSPORT_MODES[x.mode] ? x.mode : "road", vehicle: cleanVehicle(x.vehicle), docNo: txt(x.docNo, 15), docDate: /^\d{4}-\d{2}-\d{2}$/.test(x.docDate || "") ? x.docDate : "",
    distance: Number.isFinite(+x.distance) && +x.distance >= 0 ? Math.round(+x.distance) : null, transporterId: String(x.transporterId || "").toUpperCase().replace(/\s/g, ""),
    transporterName: txt(x.transporterName, 100), ...(x.to && (x.to.line || x.to.pin) ? { to: { line: txt(x.to.line, 120), city: txt(x.to.city, 50), pin: txt(x.to.pin, 6), state: txt(x.to.state, 60) } } : {}) };
}
/* The e-way bill payload of a saved bill.
   ctx: { shop, settings (einv: { pin, legalName }), customer (with addr), products (id → product), transport (as typed) }
   → { payload, missing: [{ key, label, where }], problems: [text] } */
export function ewayPayload(sale, ctx){
  const c = ctx || {}, shop = c.shop || {}, E = c.settings && c.settings.einv || {}, cust = c.customer || sale.cust || {}, T = cleanTransport(c.transport);
  const missing = [], problems = [], need = (key, label, where, ref) => missing.push({ key, label, where, ...(ref ? { ref } : {}) });
  const sGstin = String(shop.gstin || "").toUpperCase(), bGstin = String(cust.gstin || "").toUpperCase();
  const from = { line: txt(shop.address, 120), city: txt(shop.city, 50), pin: txt(E.pin, 6), state: shop.state };
  const ca = cust.addr || {}, to = T.to || { line: txt(ca.line, 120), city: txt(ca.city, 50), pin: txt(ca.pin, 6), state: ca.state };
  const fromState = gstinState(sGstin) || stateCode(from.state), toState = gstinState(bGstin) || stateCode(to.state) || fromState;
  if(!validGstin(sGstin)) need("seller_gstin", "Your shop's GSTIN", "shop");
  if(from.line.length < 3) need("seller_address", "Your shop's address", "shop");
  if(!PIN_RE.test(from.pin)) need("seller_pin", "Your shop's PIN code", "shop");
  if(to.line.length < 3) need("to_address", "Delivery address", "transport");
  if(!PIN_RE.test(to.pin)) need("to_pin", "Delivery PIN code", "transport");
  if(T.distance == null || T.distance > 4000) need("distance", "Distance (km)", "transport");
  // Part B (the vehicle) or, without it, a transporter who will add the vehicle later
  if(T.mode === "road"){
    if(!vehicleOk(T.vehicle) && !transporterOk(T.transporterId)) need("vehicle", "Vehicle number", "transport");
  } else if(!T.docNo) need("trans_doc", `${TRANSPORT_MODES[T.mode].label} receipt / transport doc number`, "transport");
  if(T.transporterId && !transporterOk(T.transporterId)) problems.push("The transporter id is 15 letters and digits (their GSTIN or enrolment id).");
  if(!docNoOk(sale.no)) problems.push(`The bill number ${sale.no || ""} is longer than 16 characters or has other symbols.`);
  const items = (sale.items || []).map(i => {
    const p = c.products ? c.products(i.p) : null, hsn = String(i.hsn || (p && p.hsn) || "").replace(/\s/g, ""), rate = +i.gst || 0, inter = +i.igst > 0;
    if(!/^[0-9]{4,8}$/.test(hsn)) need("hsn:" + i.p, `HSN code of ${i.n}`, "product", i.p);
    return { productName: txt(i.n, 100), productDesc: txt(i.vl || i.n, 100), hsnCode: +hsn || hsn, quantity: +i.q || 0, qtyUnit: unitOf(i.u).uqc || "OTH",
      cgstRate: inter ? 0 : rate / 2, sgstRate: inter ? 0 : rate / 2, igstRate: inter ? rate : 0, cessRate: 0, cessNonadvol: 0, taxableAmount: r2(i.tx != null ? i.tx : (+i.q || 0) * (+i.price || 0)) };
  });
  if(!items.length) problems.push("The bill has no lines.");
  const payload = {
    supplyType: "O", subSupplyType: "1", subSupplyDesc: "", docType: "INV", docNo: String(sale.no || ""), docDate: ddmmyyyy(sale.t),
    fromGstin: sGstin, fromTrdName: txt(E.legalName || shop.shop_name, 100), fromAddr1: from.line, fromAddr2: "", fromPlace: from.city, fromPincode: +from.pin || null,
    actFromStateCode: +fromState || null, fromStateCode: +fromState || null,
    toGstin: validGstin(bGstin) ? bGstin : "URP", toTrdName: txt(cust.name || (sale.cust && sale.cust.name), 100), toAddr1: to.line, toAddr2: "", toPlace: to.city,
    toPincode: +to.pin || null, actToStateCode: +toState || null, toStateCode: +(gstinState(bGstin) || toState) || null,
    transactionType: T.to ? 2 : 1, otherValue: r2(sale.roundOff),
    totalValue: r2(items.reduce((a, x) => a + x.taxableAmount, 0)), cgstValue: r2(sale.cgst), sgstValue: r2(sale.sgst), igstValue: r2(sale.igst), cessValue: 0, cessNonAdvolValue: 0,
    totInvValue: r2(sale.total), transporterId: T.transporterId || "", transporterName: T.transporterName || "", transDocNo: T.docNo || "",
    transMode: TRANSPORT_MODES[T.mode].code, transDistance: String(T.distance == null ? "" : T.distance), transDocDate: T.docDate ? ddmmyyyy(T.docDate) : "",
    vehicleNo: T.mode === "road" ? T.vehicle : "", vehicleType: T.mode === "road" && T.vehicle ? "R" : "",
    itemList: items,
  };
  return { payload, missing, problems, transport: T };
}
/* The e-way bill of a bill right now → { state, missing, problems } (stored: the record kept, with its transport) */
export function ewayState(sale, ctx, stored){
  if(stored && ["pending", "generated", "failed", "cancelled"].includes(stored.status)) return { state: stored.status, missing: [], problems: [], record: stored };
  if(!ewayApplies(sale, ctx && ctx.settings)) return { state: "not_required", missing: [], problems: [] };
  const r = ewayPayload(sale, { ...(ctx || {}), transport: (stored && stored.transport) || (ctx && ctx.transport) });
  return { state: r.missing.length || r.problems.length ? "needs" : "ready", missing: r.missing, problems: r.problems, payload: r.payload, transport: r.transport };
}
/* Only what is still missing goes on the screen: of the transport fields, those a missing item names */
export const transportFieldsNeeded = missing => [...new Set((missing || []).filter(m => m.where === "transport").map(m => m.key))];

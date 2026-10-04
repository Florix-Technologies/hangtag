// Rows ↔ app records for the commerce batch (schema.sql section 3r): price lists, purchase orders, e-invoice / e-way bill
// readiness, repacks, gift vouchers, webhook endpoints and deliveries.
import { store } from '../../shared/state/store.js';

const day = v => v ? String(v).slice(0, 10) : "";
const num = v => v == null || v === "" ? null : +v;

/* ---------- price lists ---------- */
export const priceListRow = l => ({ id: l.id, name: l.name, is_default: !!l.isDefault, active: l.active !== false, starts_on: l.from || null, ends_on: l.to || null,
  prices: l.prices || {}, t: l.t || Date.now(), device_id: l.dev || store.dev, updated_at: new Date().toISOString() });
export const rowToPriceList = r => ({ id: r.id, name: r.name || "", isDefault: !!r.is_default, active: r.active !== false, from: day(r.starts_on), to: day(r.ends_on),
  prices: r.prices && typeof r.prices === "object" ? Object.fromEntries(Object.entries(r.prices).map(([k, v]) => [k, +v])) : {}, t: Number(r.t) || Date.parse(r.updated_at) || 0,
  updatedAt: r.updated_at || "" });

/* ---------- purchase orders (RPC hangtag_save_purchase_order) ---------- */
const poLine = l => Object.assign({ ln: l.ln, p: l.p, v: l.v, name: l.name || "", vl: l.vl || "", q: +l.q }, l.u && l.u !== "pcs" ? { u: l.u } : {},
  l.price == null || l.price === "" ? {} : { price: +l.price }, l.gst == null || l.gst === "" ? {} : { gst: +l.gst });
export const poArgs = po => ({ p_po: { id: po.id, no: po.no || null, supplier_id: po.supplierId, status: po.status, expected_on: po.expected || null, notes: po.notes || null,
  items: (po.items || []).map(poLine), bill: po.bill || null, review: Array.isArray(po.review) ? po.review : [], source: po.source === "reorder" ? "reorder" : "staff",
  t: po.t, updated_t: po.updatedT || null, device_id: po.dev || store.dev, version: +po.version || 0 } });
export const rowToPO = r => ({ id: r.id, no: r.no || "", supplierId: r.supplier_id, status: r.status, expected: day(r.expected_on), notes: r.notes || "",
  items: Array.isArray(r.items) ? r.items.map(poLine) : [], bill: r.bill && typeof r.bill === "object" ? r.bill : null, review: Array.isArray(r.review) ? r.review : [],
  source: r.source || "staff", version: +r.version || 1, t: Number(r.t) || 0, updatedT: num(r.updated_t), dev: r.device_id || "" });

/* ---------- e-invoice and e-way bill readiness (the provider's answer is only ever read) ---------- */
export const einvRow = e => ({ sale_id: e.saleId || e.id, status: e.status, payload: e.payload || null, t: e.t || Date.now(), device_id: e.dev || store.dev });
export const rowToEinv = r => Object.assign({ id: r.sale_id, saleId: r.sale_id, status: r.status, payload: r.payload || null, t: Number(r.t) || 0 },
  r.irn ? { irn: r.irn, ackNo: r.ack_no || "", ackAt: r.ack_at || "", signedQr: r.signed_qr || "", provider: r.provider || "" } : {}, r.errors ? { errors: r.errors } : {});
export const ewayRow = e => ({ sale_id: e.saleId || e.id, status: e.status, transport: e.transport || null, payload: e.payload || null, t: e.t || Date.now(), device_id: e.dev || store.dev });
export const rowToEway = r => Object.assign({ id: r.sale_id, saleId: r.sale_id, status: r.status, transport: r.transport || null, payload: r.payload || null, t: Number(r.t) || 0 },
  r.ewb_no ? { ewbNo: r.ewb_no, ewbAt: r.ewb_at || "", validUntil: r.valid_until || "", provider: r.provider || "" } : {}, r.errors ? { errors: r.errors } : {});

/* ---------- repacks (RPC hangtag_save_repack) ---------- */
export const repackArgs = (x, moves) => {
  const out = (moves || []).find(m => m.q < 0) || {}, inn = (moves || []).find(m => m.q > 0) || {};
  return { p: { id: x.id, from_variant: x.fromV, to_variant: x.toV, from_qty: x.fromQty, to_qty: x.toQty, per: x.per, value: x.value, unit_cost: x.unitCost, t: x.t,
    device_id: x.dev || store.dev, note: inn.note || null, from_batch: out.b || null, to_batch: inn.b || null, to_expiry: inn.exp || null } };
};
export const rowToRepack = r => ({ id: r.id, fromV: r.from_variant, fromP: r.from_product, toV: r.to_variant, toP: r.to_product, fromQty: +r.from_qty, toQty: +r.to_qty,
  per: +r.per, value: num(r.value), unitCost: num(r.unit_cost), t: Number(r.t) || 0, dev: r.device_id || "" });

/* ---------- gift vouchers (made and spent only through their RPCs) ---------- */
export const rowToVoucher = r => ({ id: r.id, code: r.code, amount: +r.amount, balance: +r.balance, status: r.status, expires: day(r.expires_on), custId: r.customer_id || null,
  custName: r.customer_name || "", method: r.paid_method, note: r.note || "", cancelReason: r.cancel_reason || "", t: Number(r.t) || 0 });

/* ---------- webhooks (the owner's; never a secret, except the one create/rotate hands back once) ---------- */
export const rowToEndpoint = r => ({ id: r.id, url: r.url, events: Array.isArray(r.events) ? r.events : [], active: r.active !== false, description: r.description || "",
  lastSuccess: r.last_success_at || "", lastFailure: r.last_failure_at || "", created: r.created_at || "" });
export const rowToDelivery = r => ({ id: r.id, endpointId: r.endpoint_id, eventId: r.event_id, status: r.status, attempts: +r.attempts || 0, lastStatus: r.last_status == null ? null : +r.last_status,
  lastError: r.last_error || "", deliveredAt: r.delivered_at || "", created: r.created_at || "", type: r.hangtag_webhook_events && r.hangtag_webhook_events.type || "" });

/* ---------- bank accounts and their entries (section 3s) ---------- */
export const bankAccountRow = a => ({ id: a.id, name: a.name, bank: a.bank || null, last4: a.last4 || null, opening: +a.opening || 0, opening_date: a.openingDate,
  active: a.active !== false, is_default: !!a.isDefault, methods: (a.methods || []).filter(m => m === "upi" || m === "card") });
export const rowToBankAccount = r => ({ id: r.id, name: r.name || "", bank: r.bank || "", last4: r.last4 || "", opening: +r.opening || 0, openingDate: day(r.opening_date) || "",
  active: r.active !== false, isDefault: !!r.is_default, methods: Array.isArray(r.methods) ? r.methods : [] });
export const bankMoveRow = m => ({ id: m.id, account_id: m.account, type: m.type, amount: m.amount, to_account: m.to || null, reason: m.reason || null,
  reverses: m.reverses || null, t: m.t, device_id: m.dev || store.dev });
export const rowToBankMove = r => Object.assign({ id: r.id, account: r.account_id, type: r.type, amount: +r.amount, t: Number(r.t) || 0, dev: r.device_id || "" },
  r.to_account ? { to: r.to_account } : {}, r.reason ? { reason: r.reason } : {}, r.reverses ? { reverses: r.reverses } : {}, r.user_id ? { user: r.user_id } : {});

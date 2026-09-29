// Maps database rows to app records and back.
import { store } from '../../shared/state/store.js';
import { variantsOf } from '../../domain/catalog/variants.js';
import { isColourOption, isSizeOption, legacyCS } from '../../domain/catalog/options.js';
import { normalizeDiscount } from '../../domain/sales/discounts.js';
import { paymentsOf } from '../../domain/sales/payments.js';
import { round2 } from '../../domain/sales/paise.js';
import { saleGstSplit } from '../../domain/sales/gst.js';
import { okColor } from '../../shared/utils/colors.js';
import { roundQty, unitId } from '../../domain/catalog/units.js';

/* ---------- row <-> app shapes ---------- */

/* option snapshot on bill/return lines: app [{n,v}] <-> database [{name,value}] */
const ovToRow = ov => Array.isArray(ov) && ov.length ? ov.map(x => ({ name:x.n||"", value:x.v })) : null;
const rowToOv = o => Array.isArray(o) ? o.map(x => ({ n:x&&x.name||"", v:String(x&&x.value!=null?x.value:"") })) : [];
/* NUMERIC columns can arrive as strings */
const num = v => v==null||v==="" ? null : +v;
const numOr0 = v => +v || 0;
export const rowToItem = i => Object.assign({ p:i.product_id, v:i.variant_id||undefined, n:i.product_name, c:i.color||"", s:i.size, vl:i.variant_label||"", ov:rowToOv(i.options), sku:i.sku||"", q:roundQty(i.quantity), price:i.unit_price, cost:i.cost_price==null?null:i.cost_price, ln:i.line_no },
  // the unit it was sold in (lines saved before units: pieces)
  i.unit && i.unit !== "pcs" ? { u:i.unit } : {},
  // discounts and GST of the line (bills saved since line discounts)
  i.discount_type ? { disc:{ type:i.discount_type, value:numOr0(i.discount_value) } } : {},
  i.line_total!=null ? { dAmt:numOr0(i.discount_amount), bdAmt:numOr0(i.bill_discount_share), gst:numOr0(i.gst_rate), hsn:i.hsn||"", tx:num(i.taxable_value),
    cgst:numOr0(i.cgst_amount), sgst:numOr0(i.sgst_amount), igst:numOr0(i.igst_amount), lt:num(i.line_total) } : {});
export function rowToSale(s, items, payments){
  const sale = { id:s.id, no:s.bill_no||undefined, t:Number(s.timestamp), items:items||[], sub:numOr0(s.subtotal), disc:numOr0(s.discount), total:s.total,
    tax:numOr0(s.tax_amount), taxRate:s.tax_rate==null?0:+s.tax_rate, taxIncl:s.tax_inclusive!==false, credit:s.credit||0,
    kind:s.kind||"sale", ex:s.exchange_id||null, pay:s.payment_method, dev:s.device_id, void:s.is_void, ...(s.event_id ? { event:s.event_id } : {}), ...(s.is_void && s.void_reason ? { voidReason:s.void_reason } : {}), ...(s.user_id ? { user:s.user_id } : {}),
    cust:s.customer_id||s.customer_name?Object.assign({id:s.customer_id||null,name:s.customer_name||"",phone:s.customer_phone||""},
      s.customer_gstin?{gstin:s.customer_gstin}:{}, s.customer_type==="business"?{type:"business"}:{}):null };
  if(s.gst_mode) Object.assign(sale, { itemDisc:numOr0(s.item_discount), billDiscAmt:numOr0(s.bill_discount),
    billDisc:s.bill_discount_type?{ type:s.bill_discount_type, value:numOr0(s.bill_discount_value) }:null,
    taxable:num(s.taxable_amount), cgst:numOr0(s.cgst_amount), sgst:numOr0(s.sgst_amount), igst:numOr0(s.igst_amount), roundOff:numOr0(s.round_off),
    gst:{ mode:s.gst_mode, pos:s.place_of_supply||"" } });
  if(payments && payments.length) sale.payments = payments;
  return sale;
}
export function saleRow(s){
  const g = saleGstSplit(s), bd = normalizeDiscount(s.billDisc), itemDisc = s.itemDisc||0;
  return { id:s.id, timestamp:s.t, subtotal:s.sub, discount:s.disc||0, total:s.total, payment_method:s.pay, device_id:s.dev||store.dev,
    bill_no:s.no||null, customer_id:s.cust&&s.cust.id||null, customer_name:s.cust&&s.cust.name||null, customer_phone:s.cust&&s.cust.phone||null,
    tax_rate:s.taxRate||0, tax_amount:s.tax||0, tax_inclusive:s.taxIncl!==false, kind:s.kind||"sale", exchange_id:s.ex||null, credit:s.credit||0,
    item_discount:itemDisc, bill_discount:s.billDiscAmt!=null ? s.billDiscAmt : round2((s.disc||0)-itemDisc), bill_discount_type:bd?bd.type:null, bill_discount_value:bd?bd.value:null,
    taxable_amount:s.taxable!=null ? s.taxable : round2(s.total-(s.tax||0)-(s.roundOff||0)), cgst_amount:g.cgst, sgst_amount:g.sgst, igst_amount:g.igst,
    round_off:s.roundOff||0, gst_mode:g.mode, place_of_supply:s.gst&&s.gst.pos||null,
    customer_gstin:s.cust&&s.cust.gstin||null, customer_type:s.cust?(s.cust.type==="business"?"business":"individual"):null, event_id:s.event||null };
}
export const saleItemRows = s => (s.items||[]).map((i,k)=>{ const d = normalizeDiscount(i.disc); return { sale_id:s.id, line_no:i.ln!=null?i.ln:k, product_id:i.p, variant_id:i.v||null, product_name:i.n,
  color:i.c||"", size:i.s==null?"":i.s, variant_label:i.vl||null, options:ovToRow(i.ov), sku:i.sku||null, quantity:i.q, unit_price:i.price, cost_price:i.cost==null?null:i.cost,
  discount_type:d?d.type:null, discount_value:d?d.value:null, discount_amount:i.dAmt||0, bill_discount_share:i.bdAmt||0, taxable_value:i.tx==null?null:i.tx,
  gst_rate:i.gst==null?null:i.gst, cgst_amount:i.cgst||0, sgst_amount:i.sgst||0, igst_amount:i.igst||0, line_total:i.lt==null?null:i.lt, hsn:i.hsn||null }; });
/* A bill's payments (one row per method; bills from before split payments have one) */
export const paymentRows = s => paymentsOf(s).map(p => ({ id:p.id, sale_id:s.id, method:p.method, amount:p.amount,
  tendered:p.method==="cash" ? (p.received==null ? p.amount : p.received) : null, change_given:p.change||0, reference:p.ref||null, t:s.t, device_id:s.dev||store.dev,
  verification:p.verification||"recorded", via:p.method==="cash" ? null : p.via||null, intent_id:p.intent||null, provider_payment_id:p.providerRef||null,
  card_last4:p.method==="card" && p.last4 ? p.last4 : null }));
export const rowToPayment = r => Object.assign({ id:r.id, method:r.method, amount:+r.amount },
  r.method==="cash" ? { received:r.tendered==null ? +r.amount : +r.tendered, change:numOr0(r.change_given) } : {}, r.reference ? { ref:r.reference } : {},
  r.verification ? { verification:r.verification } : {},
  r.via ? { via:r.via } : {}, r.intent_id ? { intent:r.intent_id } : {}, r.provider_payment_id ? { providerRef:r.provider_payment_id } : {}, r.card_last4 ? { last4:r.card_last4 } : {});
/* One bill for RPC hangtag_save_sales */
export const billArgs = s => ({ sale:Object.assign(saleRow(s), { is_void:!!s.void }), items:saleItemRows(s), payments:paymentRows(s) });
/* options column: { opts:[{name, values}], colors, sizes } — colors/sizes are copies for older app versions */
export function optionsRow(p){
  const opts = Array.isArray(p.opts) ? p.opts : [], pick = f => { const o = opts.find(x => f(x.n)); return o ? o.v.slice() : []; };
  return { opts: opts.map(o => ({ name:o.n, values:o.v.slice() })), colors: pick(isColourOption), sizes: pick(isSizeOption) };
}
export const productRow = (p, idx) => ({ id:p.id, name:p.name, price:+p.price||0, color:okColor(p.color), sort_order:idx, category:p.cat||null, brand:p.brand||null,
  description:p.desc||null, cost_price:p.cost==null?null:p.cost, archived:!!p.archived, hsn:p.hsn||null, gst_rate:p.gst==null||p.gst===""?null:+p.gst,
  code_type:p.code||null, options:optionsRow(p), unit:unitId(p.unit), updated_at:new Date().toISOString() });
export const variantRows = p => variantsOf(p,true).map((v,k)=>({ id:v.id, product_id:p.id, option_values:Array.isArray(v.o)?v.o.slice():[],
  ...(cs => ({ color:cs.c, size:cs.s }))(legacyCS(p.opts, v.o)), sku:v.sku||null, barcode:v.bc||null,
  price:v.price==null?null:v.price, cost_price:v.cost==null?null:v.cost, active:v.active!==false, sort_order:k, updated_at:new Date().toISOString() }));
export const moveRow = m => ({ id:m.id, variant_id:m.v, product_id:m.p, type:m.type, qty:roundQty(m.q), cost_price:m.cost==null?null:m.cost, note:m.note||null, t:m.t, device_id:m.dev||store.dev, import_id:m.imp||null });
export const rowToMove = r => ({ id:r.id, v:r.variant_id, p:r.product_id, type:r.type, q:roundQty(r.qty), cost:r.cost_price, note:r.note||"", t:Number(r.t), dev:r.device_id, ...(r.import_id ? { imp:r.import_id } : {}), ...(r.user_id ? { user:r.user_id } : {}) });
/* A return (credit note) and its lines; amounts have paise. Lines keep the GST reversed and whether the piece went back on the shelf. */
export const returnRow = r => ({ id:r.id, sale_id:r.sale, t:r.t, kind:r.kind||"return", exchange_id:r.ex||null, refund_amount:r.refund||0, refund_method:r.pay||null,
  value:r.value||0, round_off:r.ro||0, credit_no:r.no||null, note:r.note||null, device_id:r.dev||store.dev });
export const returnItemRows = r => r.items.map((i,k)=>({ return_id:r.id, line_no:k, sale_id:r.sale, sale_line_no:i.ln, variant_id:i.v||null, product_id:i.p, product_name:i.n,
  color:i.c||"", size:i.s==null?"":i.s, variant_label:i.vl||null, options:ovToRow(i.ov), sku:i.sku||null, quantity:i.q, unit_price:i.price, value:i.value||0, cost_price:i.cost==null?null:i.cost,
  restock:i.restock!==false, taxable_value:i.tx==null?null:i.tx, gst_rate:i.gst==null?null:i.gst, cgst_amount:i.cgst||0, sgst_amount:i.sgst||0, igst_amount:i.igst||0, hsn:i.hsn||null }));
/* One return for RPC hangtag_save_return */
export const returnArgs = r => ({ p_return:returnRow(r), p_items:returnItemRows(r) });
export const custRow = c => ({ id:c.id, name:c.name, phone:c.phone||null, email:c.email||null, gstin:c.gstin||null, customer_type:c.type==='business'?'business':'individual', created_at:new Date(c.t||Date.now()).toISOString(), updated_at:new Date().toISOString() });
/* Downloads: product, variant, return, return line and customer rows to app records */
export function rowToProduct(p){
  // rows without options.opts (saved before options existed, or by an older app version) keep their colour/size lists,
  // and finishDownloadedProduct (domain/catalog/options.js) upgrades them once their variants are attached
  const o = p.options || {};
  const base = { id:p.id, name:p.name, cat:p.category||"", brand:p.brand||"", desc:p.description||"", price:p.price, cost:p.cost_price==null?null:p.cost_price,
    color:p.color, archived:!!p.archived, hsn:p.hsn||"", gst:p.gst_rate==null?null:+p.gst_rate, code:p.code_type||"", variants:[], ...(unitId(p.unit) !== "pcs" ? { unit:p.unit } : {}) };
  if(Array.isArray(o.opts)) return { ...base, opts:o.opts.map(x => ({ n:String(x&&x.name||""), v:Array.isArray(x&&x.values)?x.values.map(String):[] })) };
  return { ...base, colors:Array.isArray(o.colors)?o.colors:undefined, sizes:Array.isArray(o.sizes)?o.sizes:undefined };
}
export const rowToVariant = v => ({ id:v.id, o:Array.isArray(v.option_values)?v.option_values.map(String):[], c:v.color||"", s:v.size||"", sku:v.sku||"", bc:v.barcode||"",
  price:v.price==null?null:v.price, cost:v.cost_price==null?null:v.cost_price, active:v.active!==false });
export const rowToReturnItem = i => Object.assign({ ln:i.sale_line_no, v:i.variant_id||undefined, p:i.product_id, n:i.product_name,
  c:i.color||"", s:i.size, vl:i.variant_label||"", ov:rowToOv(i.options), sku:i.sku||"", q:roundQty(i.quantity), price:numOr0(i.unit_price), value:numOr0(i.value), cost:i.cost_price==null?null:i.cost_price },
  i.restock===false ? { restock:false } : {}, i.unit && i.unit !== "pcs" ? { u:i.unit } : {},
  // the GST reversed on the line (returns saved since credit notes)
  i.taxable_value!=null ? { tx:num(i.taxable_value), gst:numOr0(i.gst_rate), cgst:numOr0(i.cgst_amount), sgst:numOr0(i.sgst_amount), igst:numOr0(i.igst_amount), hsn:i.hsn||"" } : {});
export const rowToReturn = (r, items) => Object.assign({ id:r.id, sale:r.sale_id, t:Number(r.t), kind:r.kind||"return", ex:r.exchange_id||null, refund:numOr0(r.refund_amount),
  pay:r.refund_method||"cash", value:numOr0(r.value), note:r.note||"", dev:r.device_id, items:items||[] }, r.credit_no ? { no:r.credit_no } : {}, r.user_id ? { user:r.user_id } : {}, +r.round_off ? { ro:+r.round_off } : {},
  r.provider_refund_id ? { providerRefund:r.provider_refund_id } : {});
/* An event (Event Mode) */
/* ---------- cash without a bill, and day closes ---------- */
export const cashMoveRow = m => ({ id:m.id, type:m.type, amount:m.amount, reason:m.reason||"", category:m.category||null, reverses:m.reverses||null,
  t:m.t, device_id:m.dev||store.dev, event_id:m.event||null });
export const rowToCashMove = r => Object.assign({ id:r.id, type:r.type, amount:+r.amount, reason:r.reason||"", t:+r.t, dev:r.device_id||"" }, r.user_id ? { user:r.user_id } : {},
  r.category ? { category:r.category } : {}, r.reverses ? { reverses:r.reverses } : {}, r.event_id ? { event:r.event_id } : {});
export const dayCloseRow = c => ({ id:c.id, day:c.day, scope:c.scope, expected:c.expected, counted:c.counted, difference:c.diff, note:c.note||"", t:c.t, device_id:c.dev||store.dev });
export const rowToDayClose = r => ({ id:r.id, day:String(r.day).slice(0,10), scope:r.scope, expected:+r.expected, counted:+r.counted, diff:+r.difference, note:r.note||"", t:+r.t, dev:r.device_id||"" });
export const eventRow = e => ({ id:e.id, name:e.name, start_date:e.start, end_date:e.end, location:e.place||null, status:e.status==="closed"?"closed":"active",
  created_t:e.t||null, updated_at:new Date().toISOString() });
export const rowToEvent = r => ({ id:r.id, name:r.name, start:String(r.start_date||"").slice(0,10), end:String(r.end_date||"").slice(0,10), place:r.location||"",
  status:r.status==="closed"?"closed":"active", t:Number(r.created_t)||Date.parse(r.created_at)||0 });
/* A bill sent to its customer (hangtag_deliveries, written by the send-receipt Edge Function) */
export const rowToDelivery = r => ({ id:r.id, saleId:r.sale_id, channel:r.channel, to:r.recipient, status:r.status, provider:r.provider||"", providerId:r.provider_message_id||"", error:r.error||"",
  mode:r.mode||"manual", t:Date.parse(r.created_at)||0, ...(r.delivered_at ? { deliveredAt:Date.parse(r.delivered_at) } : {}) });
export const rowToCustomer = r => ({ id:r.id, name:r.name, phone:r.phone||"", email:r.email||"", gstin:r.gstin||"", type:r.customer_type==='business'?'business':'individual', t:Date.parse(r.created_at)||0 });

/* ---------- supplier bill imports ---------- */
export const rowToImport = r => ({ id:r.id, fileHash:r.file_hash||"", fileName:r.file_name||"", supplier:r.supplier_name||"", gstin:r.supplier_gstin||"",
  invoiceNo:r.invoice_no||"", invoiceDate:r.invoice_date||"", units:r.units||0, t:Date.parse(r.created_at)||0 });
/* The plan (domain/inventory/bill-import.js planImport) + bill details → the arguments of RPC hangtag_import_stock.
   meta: { id, fileHash, fileName, fileType, supplier, gstin, invoiceNo, invoiceDate, amount, lines, extraction, allowDuplicate } */
export function toRpcArgs(plan, meta, sortStart = 0){
  const products = [
    ...plan.newProducts.map((p, i) => ({ mode:"insert", ...productRow(p, sortStart + i) })),
    ...plan.updatedProducts.map(u => ({ mode:"update_options", id:u.id, options:optionsRow({ opts:u.opts }) })),
  ];
  const variants = [
    ...plan.newProducts.flatMap(p => variantRows(p)),
    ...plan.newVariants.map(({ productId, variant }) => {
      const u = plan.updatedProducts.find(x => x.id === productId);
      return variantRows({ id:productId, opts:u ? u.opts : [], variants:[variant] })[0];
    }),
  ];
  const moves = plan.moves.map(moveRow);
  return {
    p_import: { id:meta.id, file_hash:meta.fileHash||null, file_name:meta.fileName||null, file_type:meta.fileType||null, supplier_name:meta.supplier||null,
      supplier_gstin:meta.gstin||null, invoice_no:meta.invoiceNo||null, invoice_date:/^\d{4}-\d{2}-\d{2}$/.test(meta.invoiceDate||"")?meta.invoiceDate:null,
      line_count:plan.summary.lines, amount:meta.amount==null?null:meta.amount, lines:meta.lines||[], extraction:meta.extraction||null, device_id:store.dev },
    p_products: products, p_variants: variants, p_moves: moves, p_allow_duplicate: !!meta.allowDuplicate,
  };
}

/* ---------- the shop's team (section 3i) ---------- */
export const rowToMember = m => ({ userId:m.user_id, shopId:m.shop_id||null, name:m.name||"", username:m.username||"", role:m.role||"", status:m.status||"active",
  createdAt:m.created_at||null, lastSeenAt:m.last_seen_at||null });
export const rowToDevice = d => ({ id:d.id, userId:d.user_id, name:d.name||"", platform:d.platform||"", status:d.status||"active",
  enrolledAt:d.enrolled_at||null, lastSeenAt:d.last_seen_at||null, revokedAt:d.revoked_at||null });
export const rowToRole = r => ({ role:r.role, label:r.label||null, permissions:Array.isArray(r.permissions)?r.permissions.slice():[], updatedAt:r.updated_at||null });
/* owner_id is filled in by the database (the shop) */
export const roleRow = ({ role, label, permissions }) => ({ role, label:label||null, permissions:(permissions||[]).slice(), updated_at:new Date().toISOString() });

// Maps database rows to app records and back.
import { store } from '../../shared/state/store.js';
import { variantsOf } from '../../domain/catalog/variants.js';
import { isColourOption, isSizeOption, legacyCS } from '../../domain/catalog/options.js';
import { okColor } from '../../shared/utils/colors.js';

/* ---------- row <-> app shapes ---------- */

/* option snapshot on bill/return lines: app [{n,v}] <-> database [{name,value}] */
const ovToRow = ov => Array.isArray(ov) && ov.length ? ov.map(x => ({ name:x.n||"", value:x.v })) : null;
const rowToOv = o => Array.isArray(o) ? o.map(x => ({ n:x&&x.name||"", v:String(x&&x.value!=null?x.value:"") })) : [];
export const rowToItem = i => ({ p:i.product_id, v:i.variant_id||undefined, n:i.product_name, c:i.color||"", s:i.size, vl:i.variant_label||"", ov:rowToOv(i.options), sku:i.sku||"", q:i.quantity, price:i.unit_price, cost:i.cost_price==null?null:i.cost_price, ln:i.line_no });
export function rowToSale(s, items){
  return { id:s.id, no:s.bill_no||undefined, t:Number(s.timestamp), items:items||[], sub:s.subtotal, disc:s.discount, total:s.total,
    tax:s.tax_amount||0, taxRate:s.tax_rate==null?0:+s.tax_rate, taxIncl:s.tax_inclusive!==false, credit:s.credit||0,
    kind:s.kind||"sale", ex:s.exchange_id||null, pay:s.payment_method, dev:s.device_id, void:s.is_void,
    cust:s.customer_id||s.customer_name?{id:s.customer_id||null,name:s.customer_name||"",phone:s.customer_phone||""}:null };
}
export const saleRow = s => ({ id:s.id, timestamp:s.t, subtotal:s.sub, discount:s.disc||0, total:s.total, payment_method:s.pay, device_id:s.dev||store.dev,
  bill_no:s.no||null, customer_id:s.cust&&s.cust.id||null, customer_name:s.cust&&s.cust.name||null, customer_phone:s.cust&&s.cust.phone||null,
  tax_rate:s.taxRate||0, tax_amount:s.tax||0, tax_inclusive:s.taxIncl!==false, kind:s.kind||"sale", exchange_id:s.ex||null, credit:s.credit||0 });
export const saleItemRows = s => (s.items||[]).map((i,k)=>({ sale_id:s.id, line_no:i.ln!=null?i.ln:k, product_id:i.p, variant_id:i.v||null, product_name:i.n,
  color:i.c||"", size:i.s==null?"":i.s, variant_label:i.vl||null, options:ovToRow(i.ov), sku:i.sku||null, quantity:i.q, unit_price:i.price, cost_price:i.cost==null?null:i.cost }));
/* options column: { opts:[{name, values}], colors, sizes } — colors/sizes are copies for older app versions */
export function optionsRow(p){
  const opts = Array.isArray(p.opts) ? p.opts : [], pick = f => { const o = opts.find(x => f(x.n)); return o ? o.v.slice() : []; };
  return { opts: opts.map(o => ({ name:o.n, values:o.v.slice() })), colors: pick(isColourOption), sizes: pick(isSizeOption) };
}
export const productRow = (p, idx) => ({ id:p.id, name:p.name, price:+p.price||0, color:okColor(p.color), sort_order:idx, category:p.cat||null, brand:p.brand||null,
  description:p.desc||null, cost_price:p.cost==null?null:p.cost, archived:!!p.archived, hsn:p.hsn||null, gst_rate:p.gst==null||p.gst===""?null:+p.gst,
  code_type:p.code||null, options:optionsRow(p), updated_at:new Date().toISOString() });
export const variantRows = p => variantsOf(p,true).map((v,k)=>({ id:v.id, product_id:p.id, option_values:Array.isArray(v.o)?v.o.slice():[],
  ...(cs => ({ color:cs.c, size:cs.s }))(legacyCS(p.opts, v.o)), sku:v.sku||null, barcode:v.bc||null,
  price:v.price==null?null:v.price, cost_price:v.cost==null?null:v.cost, active:v.active!==false, sort_order:k, updated_at:new Date().toISOString() }));
export const moveRow = m => ({ id:m.id, variant_id:m.v, product_id:m.p, type:m.type, qty:Math.round(+m.q)||0, cost_price:m.cost==null?null:m.cost, note:m.note||null, t:m.t, device_id:m.dev||store.dev, import_id:m.imp||null });
export const rowToMove = r => ({ id:r.id, v:r.variant_id, p:r.product_id, type:r.type, q:r.qty, cost:r.cost_price, note:r.note||"", t:Number(r.t), dev:r.device_id, ...(r.import_id ? { imp:r.import_id } : {}) });
export const returnRow = r => ({ id:r.id, sale_id:r.sale, t:r.t, kind:r.kind||"return", exchange_id:r.ex||null, refund_amount:r.refund||0, refund_method:r.pay||null, value:r.value||0, note:r.note||null, device_id:r.dev||store.dev });
export const returnItemRows = r => r.items.map((i,k)=>({ return_id:r.id, line_no:k, sale_id:r.sale, sale_line_no:i.ln, variant_id:i.v||null, product_id:i.p, product_name:i.n,
  color:i.c||"", size:i.s==null?"":i.s, variant_label:i.vl||null, options:ovToRow(i.ov), sku:i.sku||null, quantity:i.q, unit_price:i.price, value:i.value||0, cost_price:i.cost==null?null:i.cost }));
export const custRow = c => ({ id:c.id, name:c.name, phone:c.phone||null, email:c.email||null, created_at:new Date(c.t||Date.now()).toISOString(), updated_at:new Date().toISOString() });
/* Downloads: product, variant, return, return line and customer rows to app records */
export function rowToProduct(p){
  // rows without options.opts (saved before options existed, or by an older app version) keep their colour/size lists,
  // and finishDownloadedProduct (domain/catalog/options.js) upgrades them once their variants are attached
  const o = p.options || {};
  const base = { id:p.id, name:p.name, cat:p.category||"", brand:p.brand||"", desc:p.description||"", price:p.price, cost:p.cost_price==null?null:p.cost_price,
    color:p.color, archived:!!p.archived, hsn:p.hsn||"", gst:p.gst_rate==null?null:+p.gst_rate, code:p.code_type||"", variants:[] };
  if(Array.isArray(o.opts)) return { ...base, opts:o.opts.map(x => ({ n:String(x&&x.name||""), v:Array.isArray(x&&x.values)?x.values.map(String):[] })) };
  return { ...base, colors:Array.isArray(o.colors)?o.colors:undefined, sizes:Array.isArray(o.sizes)?o.sizes:undefined };
}
export const rowToVariant = v => ({ id:v.id, o:Array.isArray(v.option_values)?v.option_values.map(String):[], c:v.color||"", s:v.size||"", sku:v.sku||"", bc:v.barcode||"",
  price:v.price==null?null:v.price, cost:v.cost_price==null?null:v.cost_price, active:v.active!==false });
export const rowToReturnItem = i => ({ ln:i.sale_line_no, v:i.variant_id||undefined, p:i.product_id, n:i.product_name,
  c:i.color||"", s:i.size, vl:i.variant_label||"", ov:rowToOv(i.options), sku:i.sku||"", q:i.quantity, price:i.unit_price, value:i.value||0, cost:i.cost_price==null?null:i.cost_price });
export const rowToReturn = (r, items) => ({ id:r.id, sale:r.sale_id, t:Number(r.t), kind:r.kind||"return", ex:r.exchange_id||null, refund:r.refund_amount||0,
  pay:r.refund_method||"cash", value:r.value||0, note:r.note||"", dev:r.device_id, items:items||[] });
export const rowToCustomer = r => ({ id:r.id, name:r.name, phone:r.phone||"", email:r.email||"", t:Date.parse(r.created_at)||0 });

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

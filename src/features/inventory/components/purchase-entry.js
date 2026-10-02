// New purchase (Inventory → Purchases → New purchase): supplier → invoice no → date → lines (scan or type a factory barcode /
// SKU, or search a product; an unknown code makes a new product on the spot) → qty, cost per piece, GST → paid now and how
// → save. Saved on this device at once (stock in, cash out of the drawer) and uploaded in one step.
// A product tracked by serial number takes one serial per piece (typed, pasted, scanned or a range: they make the quantity); one
// tracked by batch takes its batch number (and expiry date where the product keeps them) — one batch per line.
// store.purchaseForm = { supplierId, invoiceNo, invoiceDate, lines: [{ v, p, q, cost, gst, sn? (serials typed), bno?, bexp? }], paid, method, note, updateCost,
//   q (product search), quick (new product for an unknown code) | null, err, dup, line }
import { store } from '../../../shared/state/store.js';
import { vCost, vLabel, variantsOf } from '../../../domain/catalog/variants.js';
import { PURCHASE_METHODS, PURCHASE_METHOD_LABELS, lineMoney, purchaseTotals } from '../../../domain/inventory/purchase.js';
import { offSaleText } from '../../../domain/inventory/barcode-intake.js';
import { toRupees } from '../../../domain/sales/paise.js';
import { vRec } from '../services/ledger.js';
import { stockOf } from '../services/stock.js';
import { suppliersList } from '../services/purchase-state.js';
import { liveProducts } from '../../products/services/catalog.js';
import { productText, variantText } from '../../sales/services/search.js';
import { closeScanner, openScanner } from '../../sales/components/camera-scan.js';
import { findCode, intakeUnits, quickCreateProduct } from '../use-cases/intake-code.js';
import { savePurchase } from '../use-cases/record-purchase.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { can, refuse } from '../../shop/services/access.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';
import { norm } from '../../../shared/utils/text.js';
import { renderAll } from '../../../shared/ui/render.js';
import { batchesOf, expiryKept, trackingOfP } from '../services/tracking.js';
import { parseSerials } from '../../../domain/inventory/tracking.js';

/* opts: { supplierId } (from a supplier's page) */
export function openPurchaseEntry(opts={}){
  if(refuse("create_purchase","record purchases")) return;
  store.purchaseForm={supplierId:opts.supplierId||"",invoiceNo:"",invoiceDate:dayKey(Date.now()),lines:[],paid:"",method:"cash",note:"",updateCost:false,q:"",quick:null,err:"",dup:false,line:-1};
  renderPurchaseEntry();
  const c=$("#puCode"); if(c) c.focus();
}
const label=r=>[r.p.name,vLabel(r.v)].filter(Boolean).join(" · ");
function searchHits(q){
  const toks=norm(q).split(/\s+/).filter(Boolean); if(!toks.length) return [];
  const out=[];
  liveProducts().forEach(p=>variantsOf(p).forEach(v=>{ if(out.length<8&&toks.every(t=>productText(p).includes(t)||variantText(p,v).includes(t))) out.push({p,v}); }));
  return out;
}
/* A serial line's count of serials as typed so far (what its quantity is) */
const snCount=l=>{const r=parseSerials(l.sn||"");return r.error?String(l.sn||"").split(/[\s,;]+/).filter(Boolean).length:r.serials.length};
/* The extra row of a tracked line: its serial numbers, or its batch (and expiry date) */
function trackRowHTML(l,i,r){
  const t=trackingOfP(r.p);
  if(t==="serial") return `<tr class="pu-trk"><td colspan="6"><label class="f"><span class="lab">Serial numbers · <b data-pusn="${i}">${snCount(l)}</b> entered</span><textarea data-pul="${i}:sn" rows="2" placeholder="Scan or type one per line, or a range like SN001..SN010" aria-label="Serial numbers of ${esc(r.p.name)}">${esc(l.sn||"")}</textarea></label></td></tr>`;
  if(t==="batch"){
    const known=batchesOf(l.v,{all:true}).map(b=>b.b);
    return `<tr class="pu-trk"><td colspan="6"><div class="pu-bt"><label class="f"><span class="lab">Batch no.</span><input data-pul="${i}:bno" value="${esc(l.bno||"")}" maxlength="40" list="puBt${i}" autocomplete="off" aria-label="Batch number of ${esc(r.p.name)}">${known.length?`<datalist id="puBt${i}">${known.map(b=>`<option value="${esc(b)}">`).join("")}</datalist>`:""}</label>
      <label class="f"><span class="lab">Expiry${expiryKept(r.p)?"":" <small>(optional)</small>"}</span><input type="date" data-pul="${i}:bexp" value="${esc(l.bexp||"")}" aria-label="Expiry date of ${esc(r.p.name)}"></label>
      <button type="button" class="link xs" data-pur="batch:${i}">+ Another batch</button></div></td></tr>`;
  }
  return "";
}
const lineAmount=l=>{ const m=lineMoney({q:+l.q||0,cost:+l.cost||0,gst:+String(l.gst==null?"":l.gst).replace("%","")||0}); return toRupees(m.total); };
function totalsText(){
  const f=store.purchaseForm, T=purchaseTotals(f.lines);
  return f.lines.length?`${f.lines.length} line${f.lines.length===1?"":"s"} · ${T.pieces} pcs · ${inrx(T.sub)} + GST ${inrx(T.tax)} = <b>${inrx(T.total)}</b>`:"No lines yet";
}
export function renderPurchaseEntry(){
  const f=store.purchaseForm; if(!f){ closeModal(); return; }
  const sups=suppliersList(), hits=searchHits(f.q), today=dayKey(Date.now());
  const q=f.quick, units=intakeUnits();
  const quick=q?`<div class="pu-quick" id="puQuick"><h4>New product for code <b>${esc(q.code)}</b></h4><p class="note">Nobody in the catalog has this code yet. Add the product with it — you can fill in the rest later in Products.</p>
    <div class="pgrid"><label class="f full">Name<input id="qpName" data-qp="name" value="${esc(q.name)}" maxlength="80" autocomplete="off"></label>
    <label class="f">Unit<select data-qp="unit">${units.map(([c,l])=>`<option value="${esc(c)}"${c===q.unit?" selected":""}>${esc(l)}</option>`).join("")}</select></label>
    <label class="f">Selling price (₹)<input data-qp="price" inputmode="numeric" value="${esc(q.price)}"></label>
    <label class="f">Cost price (₹)<input data-qp="cost" inputmode="numeric" value="${esc(q.cost)}"></label>
    <label class="f">GST %<input data-qp="gst" inputmode="decimal" value="${esc(q.gst)}"></label>
    <label class="f">HSN<input data-qp="hsn" inputmode="numeric" value="${esc(q.hsn)}" maxlength="8"></label></div>
    ${q.err?`<p class="autherr">${esc(q.err)}</p>`:""}
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:10px"><button type="button" class="btn sm" data-pur="qpcancel">Cancel</button><button type="button" class="btn sm primary" data-pur="qpsave">Add product and line</button></div></div>`:"";
  const rows=f.lines.map((l,i)=>{const r=vRec(l.v);return `<tr${i===f.line?' class="pu-bad"':""}><td class="pu-n"><b>${esc(r?r.p.name:"(removed product)")}</b>${r&&vLabel(r.v)?`<small>${esc(vLabel(r.v))}</small>`:""}<small>now ${r?stockOf(l.v):0} in stock</small></td>
    <td><input data-pul="${i}:q" inputmode="decimal" value="${esc(l.q)}" aria-label="Quantity"${r&&trackingOfP(r.p)==="serial"?" readonly":""}></td>
    <td><input data-pul="${i}:cost" inputmode="decimal" value="${esc(l.cost)}" aria-label="Cost per piece"></td>
    <td><input data-pul="${i}:gst" inputmode="decimal" value="${esc(l.gst)}" aria-label="GST %"></td>
    <td class="pu-amt" data-pula="${i}">${inrx(lineAmount(l))}</td><td><button type="button" class="iconbtn" data-pur="rm:${i}" aria-label="Remove line">${ICON.x}</button></td></tr>${r?trackRowHTML(l,i,r):""}`}).join("");
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim data-keep><div class="sheet pu-sheet" role="dialog" aria-modal="true" aria-label="New purchase">
    <div class="sh-head"><div class="sh-t"><h3>New purchase</h3><p>A supplier's invoice: its lines add stock at their cost.</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="pgrid"><label class="f full">Supplier<select id="puSup"><option value="">${sups.length?"Choose the supplier":"No suppliers yet"}</option>${sups.map(s=>`<option value="${esc(s.id)}"${s.id===f.supplierId?" selected":""}>${esc(s.name)}</option>`).join("")}</select></label>
      <label class="f">Invoice no.<input id="puInv" value="${esc(f.invoiceNo)}" maxlength="40" autocomplete="off"></label>
      <label class="f">Invoice date<input id="puDate" type="date" value="${esc(f.invoiceDate)}" max="${esc(today)}"></label></div>
    <p class="note" style="margin:6px 0 0"><button type="button" class="link" data-sup="new:purchase">+ Add a supplier</button></p>
    <form id="purCodeForm" class="pu-code" autocomplete="off"><input id="puCode" placeholder="Scan or type a barcode or SKU" enterkeyhint="go" aria-label="Barcode or SKU"><button class="btn sm" type="submit">Add</button><button type="button" class="btn sm" data-pur="scan">Scan</button></form>
    <div class="search pu-q"><input id="puQ" type="search" placeholder="…or search a product by name" value="${esc(f.q)}" autocomplete="off"></div>
    ${hits.length?`<div class="pu-hits">${hits.map(h=>`<button type="button" class="chip" data-pur="addv:${esc(h.v.id)}">${esc(label(h))}</button>`).join("")}</div>`:f.q?`<p class="note">No product matches.</p>`:""}
    ${quick}
    ${f.lines.length?`<div class="tw"><table class="pu-lines"><thead><tr><th>Product</th><th>Qty</th><th>Cost / pc (₹)</th><th>GST %</th><th>Amount</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`:`<p class="muted pu-empty">Scan the first item, or search for it.</p>`}
    <div class="pgrid" style="margin-top:12px"><label class="f">Paid now (₹)<input id="puPaid" inputmode="decimal" value="${esc(f.paid)}" placeholder="0"></label>
      <label class="f">Paid by<select id="puMethod">${PURCHASE_METHODS.map(m=>`<option value="${m}"${m===f.method?" selected":""}>${PURCHASE_METHOD_LABELS[m]}</option>`).join("")}</select></label>
      <label class="f full">Note <small>(optional)</small><input id="puNote" value="${esc(f.note)}" maxlength="200"></label></div>
    ${can("manage_products")?`<label class="chk"><input type="checkbox" id="puCost"${f.updateCost?" checked":""}> Update cost prices to these costs</label>`:""}
    <p id="puErr" class="autherr"${f.err?"":" hidden"}>${esc(f.err)}</p>
    <div class="sh-foot"><span class="pk-sum" id="puSum">${totalsText()}</span><div class="sh-acts"><button class="btn sm" data-modal-close>Cancel</button>${f.dup?`<button class="btn sm" data-pur="savedup">Save anyway</button>`:""}<button class="btn sm primary" data-pur="save" id="puSave"${f.lines.length?"":" disabled"}>Save purchase</button></div></div>
  </div></div>`;
}
function updateTotals(){
  const f=store.purchaseForm; if(!f) return;
  f.lines.forEach((l,i)=>{const c=$(`#modalHost [data-pula="${i}"]`);if(c)c.textContent=inrx(lineAmount(l))});
  const s=$("#puSum"); if(s) s.innerHTML=totalsText();
  const b=$("#puSave"); if(b) b.disabled=!f.lines.length;
}
/* One more of a variant on the purchase (a line of its own the first time, with its cost price and GST) */
export function addPurchaseLine(vid,q=1){
  const f=store.purchaseForm, r=vRec(vid); if(!f||!r) return null;
  const l=f.lines.find(x=>x.v===vid), serial=trackingOfP(r.p)==="serial";
  // a serial line's quantity is its serials: scanning the product again only brings its line up
  if(l){ if(!serial) l.q=String((+l.q||0)+q); }
  else{ const c=vCost(r.p,r.v); f.lines.push({v:vid,p:r.p.id,q:serial?"0":String(q),cost:c==null?"":String(c),gst:r.p.gst==null?"":String(r.p.gst),...(serial?{sn:""}:{})}); }
  f.err=""; f.dup=false; f.line=-1;
  return {label:label(r),q:+(l?l.q:q)};
}
/* A code scanned or typed → a line; an unknown code opens "new product" → { status, message } */
export function purchaseCode(raw){
  const f=store.purchaseForm; if(!f) return {status:"invalid",message:""};
  const r=findCode(raw);
  if(r.error) return {status:"invalid",message:r.error};
  if(r.off) return {status:"invalid",message:offSaleText(r.off)};
  if(r.unknown){
    if(!can("manage_products")) return {status:"not-found",message:`No product has code ${r.unknown}. Ask someone who can add products to add it first.`};
    f.quick={code:r.unknown,name:"",unit:"pcs",price:"",cost:"",gst:"",hsn:"",err:""};
    return {status:"new",message:`New code ${r.unknown}: add the product.`};
  }
  const a=addPurchaseLine(r.hit.v.id);
  return {status:"added",message:`Added ${a.label}${a.q>1?` · ${a.q} on this purchase`:""}`};
}
function scanForPurchase(){
  openScanner({title:"Scan for this purchase",
    // an unknown code: the scanner closes so the new product can be typed in
    onCode:text=>{const r=purchaseCode(text);if(r.status==="new"){setTimeout(closeScanner,0);return {status:"added",message:r.message}}return r},
    footer:()=>{const f=store.purchaseForm;return f?totalsText().replace(/<[^>]+>/g,""):""},
    onType:()=>{renderPurchaseEntry();const c=$("#puCode");if(c)c.focus()},
    onClose:()=>{renderPurchaseEntry();const n=$("#qpName");if(n)n.focus()}});
}
function savePurchaseNow(allowDuplicate){
  const f=store.purchaseForm; if(!f) return;
  // serials as typed (the use case reads them), batches as { no, exp }
  const lines=f.lines.map(l=>{const {sn,bno,bexp,...x}=l;return Object.assign(x,sn!=null?{snText:sn}:{},bno!=null||bexp!=null?{batch:{no:bno||"",exp:bexp||""}}:{})});
  const r=savePurchase({supplierId:f.supplierId,invoiceNo:f.invoiceNo,invoiceDate:f.invoiceDate,lines,paid:f.paid,method:f.method,note:f.note},{allowDuplicate,updateCost:f.updateCost});
  if(r.error){ f.err=r.error; f.dup=!!r.duplicate; f.line=r.line==null?-1:r.line; renderPurchaseEntry(); return; }
  store.purchaseForm=null; closeModal(); renderSync(); flushSbQueue(); renderAll();
  toast(`Purchase saved: ${r.totals.pieces} pcs in stock · ${inrx(r.purchase.total)}${r.purchase.paid?` · ${inrx(r.purchase.paid)} paid`:""}.`);
}
/* ---------- events (from app/events/dom-events.js through inventory-views.js) ---------- */
export function purchaseClick(t){
  const f=store.purchaseForm; if(!f) return false;
  const b=t.closest("[data-pur]"); if(!b) return false;
  const [act,arg]=[b.dataset.pur.split(":")[0],b.dataset.pur.slice(b.dataset.pur.indexOf(":")+1)];
  if(act==="rm"){ f.lines.splice(+arg,1); f.err=""; f.dup=false; renderPurchaseEntry(); }
  else if(act==="batch"){ const l=f.lines[+arg]; if(l){ f.lines.splice(+arg+1,0,{v:l.v,p:l.p,q:"",cost:l.cost,gst:l.gst,bno:"",bexp:""}); f.err=""; renderPurchaseEntry(); const b=$(`[data-pul="${+arg+1}:bno"]`); if(b) b.focus(); } }
  else if(act==="addv"){ addPurchaseLine(arg); f.q=""; renderPurchaseEntry(); const c=$("#puCode"); if(c) c.focus(); }
  else if(act==="scan") scanForPurchase();
  else if(act==="qpcancel"){ f.quick=null; renderPurchaseEntry(); }
  else if(act==="qpsave"){
    const q=f.quick; if(!q) return true;
    const r=quickCreateProduct(q);
    if(r.error){ q.err=r.error; renderPurchaseEntry(); return true; }
    f.quick=null; addPurchaseLine(r.variant.id);
    const l=f.lines.find(x=>x.v===r.variant.id); if(l){ if(q.cost!=="") l.cost=String(q.cost); if(q.gst!=="") l.gst=String(q.gst); }
    renderSync(); flushSbQueue(); renderPurchaseEntry(); toast(`${r.product.name} added to the catalog.`);
    const c=$("#puCode"); if(c) c.focus();
  }
  else if(act==="save") savePurchaseNow(false);
  else if(act==="savedup") savePurchaseNow(true);
  else return false;
  return true;
}
export function purchaseInput(t){
  const f=store.purchaseForm; if(!f) return false;
  if(t.dataset.pul){ const [i,k]=t.dataset.pul.split(":"), l=f.lines[+i]; if(l){ l[k]=t.value;
    // serials typed: they make the quantity
    if(k==="sn"){ l.q=String(snCount(l)); const qi=$(`#modalHost [data-pul="${i}:q"]`), c=$(`#modalHost [data-pusn="${i}"]`); if(qi) qi.value=l.q; if(c) c.textContent=l.q; }
    updateTotals(); } return true; }
  if(t.dataset.qp&&f.quick){ f.quick[t.dataset.qp]=t.value; return true; }
  if(t.id==="puQ"){ f.q=t.value; const pos=t.selectionStart; renderPurchaseEntry(); const i=$("#puQ"); if(i){ i.focus(); i.setSelectionRange(pos,pos); } return true; }
  const map={puInv:"invoiceNo",puDate:"invoiceDate",puPaid:"paid",puNote:"note"};
  if(map[t.id]){ f[map[t.id]]=t.value; if(t.id==="puInv"){ f.dup=false; } return true; }
  return false;
}
export function purchaseChange(t){
  const f=store.purchaseForm; if(!f) return false;
  if(t.id==="puSup"){ f.supplierId=t.value; f.dup=false; return true; }
  if(t.id==="puMethod"){ f.method=t.value; return true; }
  if(t.id==="puCost"){ f.updateCost=t.checked; return true; }
  if(t.dataset.qp&&f.quick){ f.quick[t.dataset.qp]=t.value; return true; }
  return false;
}
export function purchaseSubmit(e){
  if(e.target.id!=="purCodeForm"||!store.purchaseForm) return false;
  e.preventDefault();
  const i=$("#puCode"), raw=i?i.value:"", r=purchaseCode(raw);
  if(r.status==="invalid"||r.status==="not-found"){ store.purchaseForm.err=r.message; renderPurchaseEntry(); const c=$("#puCode"); if(c){ c.value=raw; c.focus(); c.select(); } return true; }
  store.purchaseForm.err="";
  renderPurchaseEntry();
  const n=r.status==="new"?$("#qpName"):$("#puCode"); if(n) n.focus();
  if(r.status==="added") toast(r.message);
  return true;
}
/* The supplier just added from the purchase: chosen for it */
export function purchaseSupplierAdded(id){ if(store.purchaseForm){ store.purchaseForm.supplierId=id; renderPurchaseEntry(); } }

// Inventory → Purchases and Inventory → Suppliers: the purchases made (newest first, what is still owed on each), the
// suppliers with what the shop owes them, one supplier's account (purchases, total, paid, outstanding, payments), a later
// payment (for one invoice or on account), reversing a payment made by mistake, and one purchase in full (cancel it: its
// stock goes back out). store.supplierView = { id (the supplier open, or null), form (the sheet open, or null) }.
import { store } from '../../../shared/state/store.js';
import { PURCHASE_METHODS, PURCHASE_METHOD_LABELS, purchaseDue } from '../../../domain/inventory/purchase.js';
import { supplierAccountOf, purchasesList, supplierById, supplierPaysList, suppliersList } from '../services/purchase-state.js';
import { saveSupplier, recordSupplierPayment, reverseSupplierPayment, setSupplierActive } from '../use-cases/manage-suppliers.js';
import { cancelPurchase } from '../use-cases/record-purchase.js';
import { openPurchaseEntry, purchaseSupplierAdded, renderPurchaseEntry } from './purchase-entry.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { can } from '../../shop/services/access.js';
import { kpi } from '../../../shared/components/kpi.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab } from '../../../shared/formatting/dates.js';
import { inrx, moneyLabel } from '../../../shared/formatting/money.js';
import { renderAll } from '../../../shared/ui/render.js';

const V=()=>store.supplierView||(store.supplierView={id:null,form:null});
const payments=()=>supplierPaysList();
const when=p=>p.invoiceDate?dayLab(p.invoiceDate):dayLab(dayKey(p.t));
function purchaseRowHTML(p,pays){
  const due=purchaseDue(p,pays), off=p.status==="cancelled";
  return `<button type="button" class="pu-row${off?" off":""}" data-sup="purchase:${esc(p.id)}"><span class="pu-d">${esc(when(p))}</span><span class="pu-w"><b>${esc(p.supplier||"No supplier")}</b><small>${esc([p.invoiceNo?"Invoice "+p.invoiceNo:"",p.lines.length+" line"+(p.lines.length===1?"":"s")].filter(Boolean).join(" · "))}${off?" · cancelled":""}</small></span><span class="pu-a">${inrx(p.total)}${!off&&due>0?`<small class="lowtxt">${inrx(due)} due</small>`:off?"":`<small>paid</small>`}</span></button>`;
}
/* ---------- Inventory → Purchases ---------- */
export function renderPurchasesView(host){
  const ps=purchasesList(), pays=payments(), month=dayKey(Date.now()).slice(0,7);
  const posted=ps.filter(p=>p.status!=="cancelled"), thisMonth=posted.filter(p=>dayKey(p.t).slice(0,7)===month);
  const owed=posted.reduce((a,p)=>a+purchaseDue(p,pays),0);
  let h=`<div class="kpis four">${kpi("Purchases this month",inrx(thisMonth.reduce((a,p)=>a+p.total,0)),`${thisMonth.length} invoice${thisMonth.length===1?"":"s"}`)}${kpi("Owed to suppliers",inrx(owed),"on invoices not fully paid",owed>0?"warn":"")}${kpi("Suppliers",String(suppliersList().length),"active")}${kpi("Purchases",String(posted.length),"in all")}</div>`;
  h+=`<div class="card"><div class="card-h"><h3>Purchases</h3>${can("create_purchase")?`<button class="btn sm primary" data-pur-open="new">+ New purchase</button>`:""}</div>
    ${ps.length?`<div class="pu-list">${ps.slice(0,200).map(p=>purchaseRowHTML(p,pays)).join("")}</div>`:`<p class="muted">No purchases yet. Record a supplier's invoice with New purchase: its stock goes in at its cost.</p>`}</div>`;
  host.innerHTML=h;
}
/* ---------- Inventory → Suppliers ---------- */
export function renderSuppliersView(host){
  const v=V(), s=v.id?supplierById(v.id):null;
  if(s){ host.innerHTML=supplierDetailHTML(s); return; }
  v.id=null;
  const all=suppliersList(true);
  const rows=all.map(x=>{const a=supplierAccountOf(x.id);return `<button type="button" class="pu-row${x.active===false?" off":""}" data-sup="open:${esc(x.id)}"><span class="pu-w"><b>${esc(x.name)}</b><small>${esc([x.phone,x.gstin,a.count+" purchase"+(a.count===1?"":"s")].filter(Boolean).join(" · "))}${x.active===false?" · switched off":""}</small></span><span class="pu-a">${a.outstanding>0?`${inrx(a.outstanding)}<small class="lowtxt">owed</small>`:a.outstanding<0?`${inrx(-a.outstanding)}<small>paid ahead</small>`:`<small>nothing owed</small>`}</span></button>`}).join("");
  host.innerHTML=`<div class="card"><div class="card-h"><h3>Suppliers</h3>${can("create_purchase")||can("manage_inventory")?`<button class="btn sm primary" data-sup="new">+ Add supplier</button>`:""}</div>
    ${all.length?`<div class="pu-list">${rows}</div>`:`<p class="muted">No suppliers yet. Add the people you buy stock from: each one's purchases, payments and what you owe them stay together.</p>`}</div>`;
}
function supplierDetailHTML(s){
  const a=supplierAccountOf(s.id), pays=payments(), buy=can("create_purchase");
  const payRows=a.payments.map(x=>{const rev=pays.some(y=>y.reverses===x.id);return `<div class="mv"><span class="mv-t">${esc(dayLab(dayKey(x.t)))}</span><span class="mv-n"><b>${x.reverses?"Reversal":"Payment"}</b><small>${esc([PURCHASE_METHOD_LABELS[x.method]||x.method,x.ref,x.purchaseId?"for "+(((store.purchases||{})[x.purchaseId]||{}).invoiceNo||"an invoice"):"on account",x.note].filter(Boolean).join(" · "))}${rev?" · reversed":""}</small></span><span class="mv-q ${x.reverses?"neg":"pos"}">${x.reverses?"−":""}${inrx(x.amount)}</span>${buy&&!x.reverses&&!rev?`<button class="btn xs ghost" data-sup="rev:${esc(x.id)}">Reverse</button>`:""}</div>`}).join("");
  return `<div class="card"><div class="card-h"><div><button type="button" class="link" data-sup="back">‹ All suppliers</button><h3>${esc(s.name)}${s.active===false?` <span class="btag">Switched off</span>`:""}</h3><p class="note">${esc([s.phone,s.email,s.gstin?"GSTIN "+s.gstin:"",s.address].filter(Boolean).join(" · ")||"No contact details")}</p></div>
    <div class="row" style="gap:6px;flex-wrap:wrap">${buy&&s.active!==false?`<button class="btn sm primary" data-pur-open="sup:${esc(s.id)}">+ New purchase</button><button class="btn sm" data-sup="pay:${esc(s.id)}">Record payment</button>`:""}${can("create_purchase")||can("manage_inventory")?`<button class="btn sm" data-sup="edit:${esc(s.id)}">Edit</button><button class="btn sm" data-sup="${s.active===false?"on":"off"}:${esc(s.id)}">${s.active===false?"Switch on":"Switch off"}</button>`:""}</div></div>
    <div class="kpis four">${kpi("Purchases",inrx(a.total),`${a.count} invoice${a.count===1?"":"s"}`)}${kpi("Paid",inrx(a.paid),"at purchase and later")}${kpi(a.outstanding<0?"Paid ahead":"Outstanding",inrx(Math.abs(a.outstanding)),a.outstanding>0?"still to pay":"",a.outstanding>0?"warn":"")}</div>
    ${s.notes?`<p class="note">${esc(s.notes)}</p>`:""}
    <h4 class="pu-h4">Purchases</h4>${a.purchases.length?`<div class="pu-list">${a.purchases.map(p=>purchaseRowHTML(p,pays)).join("")}</div>`:`<p class="muted">No purchases from ${esc(s.name)} yet.</p>`}
    <h4 class="pu-h4">Payments</h4>${payRows?`<div class="mvlist">${payRows}</div>`:`<p class="muted">No later payments. Money paid when the stock came is on each purchase.</p>`}</div>`;
}
/* ---------- sheets ---------- */
function sheet(label,body,foot){
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim data-keep><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">
    <div class="sh-head"><div class="sh-t"><h3>${esc(label)}</h3></div><button class="iconbtn" data-sup="close" aria-label="Close">${ICON.x}</button></div>${body}
    <p id="supErr" class="autherr"${V().form&&V().form.err?"":" hidden"}>${esc(V().form&&V().form.err||"")}</p><div class="sh-foot"><span></span><div class="sh-acts"><button class="btn sm" data-sup="close">Cancel</button>${foot}</div></div></div></div>`;
}
export function renderSupplierSheet(){
  const f=V().form; if(!f){ closeModal(); return; }
  if(f.kind==="sup"){
    const x=f.values;
    sheet(f.id?"Edit supplier":"Add supplier",`<form id="supForm" class="pgrid" autocomplete="off"><label class="f full">Name<input name="name" value="${esc(x.name)}" maxlength="80" required></label>
      <label class="f">Phone<input name="phone" value="${esc(x.phone)}" inputmode="tel" maxlength="20"></label><label class="f">Email<input name="email" value="${esc(x.email)}" type="email" maxlength="120"></label>
      <label class="f">GSTIN<input name="gstin" value="${esc(x.gstin)}" maxlength="15" style="text-transform:uppercase"></label><label class="f">Address<input name="address" value="${esc(x.address)}" maxlength="300"></label>
      <label class="f full">Notes<textarea name="notes" rows="2" maxlength="500">${esc(x.notes)}</textarea></label><button type="submit" hidden></button></form>`,
      `<button class="btn sm primary" data-sup="savesup">${f.id?"Save":"Add supplier"}</button>`);
  } else if(f.kind==="pay"){
    const s=supplierById(f.supplierId), pays=payments(), open=purchasesList().filter(p=>p.supplierId===f.supplierId&&purchaseDue(p,pays)>0);
    sheet(`Pay ${s?s.name:"supplier"}`,`<form id="spayForm" class="pgrid" autocomplete="off"><label class="f full">For<select name="purchase"><option value="">On account (no one invoice)</option>${open.map(p=>`<option value="${esc(p.id)}"${p.id===f.purchaseId?" selected":""}>${esc((p.invoiceNo?"Invoice "+p.invoiceNo:"Purchase")+" · "+when(p)+" · "+inrx(purchaseDue(p,pays))+" due")}</option>`).join("")}</select></label>
      <label class="f">${esc(moneyLabel("Amount"))}<input name="amount" inputmode="decimal" value="${esc(f.amount||"")}" required></label><label class="f">Paid by<select name="method">${PURCHASE_METHODS.map(m=>`<option value="${m}"${m===(f.method||"cash")?" selected":""}>${PURCHASE_METHOD_LABELS[m]}</option>`).join("")}</select></label>
      <label class="f">Reference <small>(UPI / cheque no.)</small><input name="ref" maxlength="60" value="${esc(f.ref||"")}"></label><label class="f">Note<input name="note" maxlength="200" value="${esc(f.note||"")}"></label><button type="submit" hidden></button></form>
      <p class="note">Cash comes out of the drawer: it shows in the cash book as “Cash out”.</p>`,`<button class="btn sm primary" data-sup="savepay">Record payment</button>`);
  } else if(f.kind==="rev"){
    const x=payments().find(y=>y.id===f.id);
    sheet("Reverse payment",`<p>${x?`${inrx(x.amount)} paid by ${esc(PURCHASE_METHOD_LABELS[x.method]||x.method)} on ${esc(dayLab(dayKey(x.t)))} is taken back in full.`:"That payment wasn't found."}</p><form id="srevForm" autocomplete="off"><label class="f">Why?<input name="reason" maxlength="200" required></label><button type="submit" hidden></button></form>`,
      `<button class="btn sm primary" data-sup="saverev">Reverse payment</button>`);
  } else if(f.kind==="purchase"){
    const p=(store.purchases||{})[f.id]; if(!p){ V().form=null; closeModal(); return; }
    const pays=payments(), due=purchaseDue(p,pays), later=pays.filter(x=>x.purchaseId===p.id);
    const lines=p.lines.map(l=>`<tr><td><b>${esc(l.n)}</b>${l.vl?`<small>${esc(l.vl)}</small>`:""}</td><td>${esc(l.q)}</td><td>${inrx(l.cost)}</td><td>${esc(l.gst)}%</td><td>${inrx(l.total)}</td></tr>`).join("");
    sheet(`Purchase${p.invoiceNo?" · Invoice "+p.invoiceNo:""}`,`<p class="note">${esc([p.supplier||"No supplier",p.gstin?"GSTIN "+p.gstin:"",when(p)].filter(Boolean).join(" · "))}${p.status==="cancelled"?` · <b>Cancelled</b>${p.cancelReason?": "+esc(p.cancelReason):""}`:""}</p>
      <div class="tw"><table class="pu-lines ro"><thead><tr><th>Product</th><th>Qty</th><th>Cost / pc</th><th>GST</th><th>Amount</th></tr></thead><tbody>${lines}</tbody></table></div>
      <div class="pu-tot"><span>Subtotal ${inrx(p.sub)} · GST ${inrx(p.tax)}</span><b>Total ${inrx(p.total)}</b></div>
      <p class="note">Paid at purchase: ${inrx(p.paid)}${p.method?" ("+esc(PURCHASE_METHOD_LABELS[p.method]||p.method)+")":""}${later.length?` · later: ${later.map(x=>(x.reverses?"−":"")+inrx(x.amount)).join(", ")}`:""}${p.status!=="cancelled"?` · <b>${due>0?inrx(due)+" still due":"fully paid"}</b>`:""}${p.note?" · "+esc(p.note):""}</p>
      ${f.cancel?`<form id="pcancelForm" autocomplete="off"><label class="f">Why is it cancelled?<input name="reason" maxlength="200" required placeholder="e.g. entered twice, goods sent back"></label><p class="note">Its ${p.lines.reduce((a,l)=>a+(+l.q||0),0)} pcs leave the stock again${p.method==="cash"&&p.paid>0?`, and ${inrx(p.paid)} cash goes back into the drawer`:""}.</p><button type="submit" hidden></button></form>`:""}`,
      p.status==="cancelled"?"":`${can("create_purchase")&&due>0&&!f.cancel&&p.supplierId?`<button class="btn sm" data-sup="paydue:${esc(p.id)}">Pay ${inrx(due)}</button>`:""}${can("create_purchase")&&can("manage_inventory")?(f.cancel?`<button class="btn sm primary" data-sup="docancel:${esc(p.id)}">Cancel purchase</button>`:`<button class="btn sm" data-sup="cancel:${esc(p.id)}">Cancel purchase…</button>`):""}`);
  }
  const first=$("#modalHost form input, #modalHost form select"); if(first&&f.kind!=="purchase") first.focus();
}
const formValues=id=>{const fm=$("#"+id);const o={};if(fm)new FormData(fm).forEach((v,k)=>{o[k]=String(v)});return o};
function done(msg){ V().form=null; closeModal(); renderSync(); flushSbQueue(); renderAll(); if(msg) toast(msg); }
function fail(err){ const f=V().form; if(f){ f.err=err; } const e=$("#supErr"); if(e){ e.textContent=err; e.hidden=false; } }
function closeSheet(){
  const f=V().form; V().form=null;
  if(f&&f.from==="purchase"&&store.purchaseForm){ renderPurchaseEntry(); return; }
  closeModal();
}
function saveSupForm(){
  const f=V().form, x=formValues("supForm"); f.values={...f.values,...x};
  const r=saveSupplier({...x,id:f.id||undefined});
  if(r.error) return fail(r.error);
  if(f.from==="purchase"&&store.purchaseForm){ V().form=null; renderSync(); flushSbQueue(); purchaseSupplierAdded(r.supplier.id); toast(`${r.supplier.name} added.`); return; }
  if(r.created) V().id=r.supplier.id;
  done(r.created?`${r.supplier.name} added.`:"Supplier saved.");
}
function savePayForm(){
  const f=V().form, x=formValues("spayForm"); Object.assign(f,{purchaseId:x.purchase||"",amount:x.amount,method:x.method,ref:x.ref,note:x.note});
  const r=recordSupplierPayment({supplierId:f.supplierId,purchaseId:x.purchase||null,amount:x.amount,method:x.method,ref:x.ref,note:x.note});
  if(r.error) return fail(r.error);
  done(`Payment of ${inrx(r.payment.amount)} recorded.`);
}
/* ---------- events (from app/events/dom-events.js through inventory-views.js) ---------- */
export function supplierClick(t){
  const po=t.closest("[data-pur-open]");
  if(po){ const a=po.dataset.purOpen; openPurchaseEntry(a.startsWith("sup:")?{supplierId:a.slice(4)}:{}); return true; }
  const b=t.closest("[data-sup]"); if(!b) return false;
  const d=b.dataset.sup, i=d.indexOf(":"), act=i<0?d:d.slice(0,i), arg=i<0?"":d.slice(i+1), v=V();
  if(act==="new"){ v.form={kind:"sup",id:null,from:arg,values:{name:"",phone:"",email:"",gstin:"",address:"",notes:""},err:""}; renderSupplierSheet(); }
  else if(act==="edit"){ const s=supplierById(arg); if(s){ v.form={kind:"sup",id:s.id,values:{...s},err:""}; renderSupplierSheet(); } }
  else if(act==="open"){ v.id=arg; renderAll(); window.scrollTo(0,0); }
  else if(act==="back"){ v.id=null; renderAll(); }
  else if(act==="off"||act==="on"){ const r=setSupplierActive(arg,act==="on"); if(r.error) toast(r.error); else done(act==="on"?"Supplier switched on.":"Supplier switched off: it isn't offered for new purchases."); }
  else if(act==="pay"){ v.form={kind:"pay",supplierId:arg,purchaseId:"",err:""}; renderSupplierSheet(); }
  else if(act==="rev"){ v.form={kind:"rev",id:arg,err:""}; renderSupplierSheet(); }
  else if(act==="purchase"){ v.form={kind:"purchase",id:arg,cancel:false,err:""}; renderSupplierSheet(); }
  else if(act==="paydue"){ const p=(store.purchases||{})[arg]; if(p){ v.form={kind:"pay",supplierId:p.supplierId,purchaseId:p.id,amount:String(purchaseDue(p,payments())),err:""}; renderSupplierSheet(); } }
  else if(act==="cancel"){ if(v.form){ v.form.cancel=true; renderSupplierSheet(); const r=$("#pcancelForm input"); if(r) r.focus(); } }
  else if(act==="docancel") submitCancel();
  else if(act==="savesup") saveSupForm();
  else if(act==="savepay") savePayForm();
  else if(act==="saverev") submitReverse();
  else if(act==="close") closeSheet();
  else return false;
  return true;
}
function submitCancel(){
  const f=V().form; if(!f) return;
  const r=cancelPurchase(f.id,formValues("pcancelForm").reason||"");
  if(r.error) return fail(r.error);
  done("Purchase cancelled: its stock is taken back out.");
}
function submitReverse(){
  const f=V().form; if(!f) return;
  const r=reverseSupplierPayment(f.id,formValues("srevForm").reason||"");
  if(r.error) return fail(r.error);
  done("Payment reversed.");
}
export function supplierSubmit(e){
  const id=e.target.id; if(!["supForm","spayForm","srevForm","pcancelForm"].includes(id)||!V().form) return false;
  e.preventDefault();
  if(id==="supForm") saveSupForm(); else if(id==="spayForm") savePayForm(); else if(id==="srevForm") submitReverse(); else submitCancel();
  return true;
}

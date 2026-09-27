// Customers: choose / add one for the bill (Sell), the add/edit form, and a customer's profile with purchase history.
import { store } from '../../../shared/state/store.js';
import { CUSTOMER_TYPES, searchCustomers, typeLabel } from '../../../domain/customers/customer.js';
import { custStats } from '../services/customer-stats.js';
import { purchaseHistory } from '../services/purchase-history.js';
import { customerRepository } from '../repositories/customer-repository.js';
import { saveCustomer, setBillCustomer } from '../use-cases/save-customer.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { renderAll } from '../../../shared/ui/render.js';
import { initials } from '../../../shared/utils/text.js';

/* store.custForm = { id?, name, phone, email, gstin, type, from: "sell" | "page", err, field, dup } while the form is open */
const badge = c => c.type === "business" ? `<span class="ctype">Business</span>` : "";
const sheet = (label, inner) => `<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">${inner}</div></div>`;

/* ---------- Sell: customer for this bill ---------- */
export function openCustPicker(){ store.custQ=""; store.custForm=null; renderCustPicker(); const i=$("#custQ"); if(i) i.focus(); }
export function renderCustPicker(){
  if(store.custForm){ renderCustForm(); return; }
  const st=custStats(), list=searchCustomers(customerRepository().list(), store.custQ, st).slice(0,30);
  $("#modalHost").innerHTML=sheet("Customer",`
    <div class="sh-head"><div class="sh-t"><h3>Customer for this bill</h3><p>Optional. Pick someone, add them, or carry on without one.</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="search"><input id="custQ" type="search" placeholder="Search name or mobile" value="${esc(store.custQ)}" autocomplete="off" inputmode="search"></div>
    <div class="custlist" id="custPickList">${list.length?list.map(c=>{const s=st[c.id]||{bills:0,total:0};return `<div class="custrow"><button class="custpick" data-custpick="${esc(c.id)}"><span class="avatar sm">${esc(initials(c.name))}</span><span><b>${esc(c.name)}${badge(c)}</b><small>${esc(c.phone||c.email||"")}${s.bills?" · "+s.bills+" bill"+(s.bills>1?"s":"")+" · "+inr(s.total):""}</small></span></button><button class="iconbtn sm" data-custhist="${esc(c.id)}" aria-label="History of ${esc(c.name)}">${ICON.up||"›"}</button></div>`}).join(""):`<p class="muted">${store.custQ?"No customer matches “"+esc(store.custQ)+"”.":"No customers yet."}</p>`}</div>
    <div class="setactions"><button class="btn sm primary" data-act="custnew">+ Add new customer</button><button class="btn sm" data-act="nocust">Continue without customer</button></div>`);
}

/* ---------- the add / edit form (Sell and the Customers page) ---------- */
export function newCustomerForm(from){
  const q=String(store.custQ||"").trim(), phoneLike=/^[+\d][\d\s()-]*$/.test(q);
  store.custForm={name:phoneLike?"":q,phone:phoneLike?q:"",email:"",gstin:"",type:"individual",from};
  renderCustForm(); const i=$("#custForm [name=name]"); if(i) i.focus();
}
export function editCustomerForm(id){
  const c=customerRepository().get(id); if(!c) return;
  store.custForm={id:c.id,name:c.name,phone:c.phone||"",email:c.email||"",gstin:c.gstin||"",type:c.type||"individual",from:store.prefs.tab==="customers"?"page":"sell"};
  renderCustForm();
}
export function custFormHTML(){
  const c=store.custForm||{}, biz=c.type==="business";
  const dupBtn=c.dup?(c.from==="sell"?`<button type="button" class="btn xs" data-custpick="${esc(c.dup.id)}">Use ${esc(c.dup.name)}</button>`:`<button type="button" class="btn xs" data-custhist="${esc(c.dup.id)}">Open ${esc(c.dup.name)}</button>`):"";
  return `<form id="custForm" class="authform" novalidate>
    <div class="ctypes" role="radiogroup" aria-label="Customer type">${CUSTOMER_TYPES.map(([v,l])=>`<label class="ctypeopt"><input type="radio" name="type" value="${v}"${(c.type||"individual")===v?" checked":""}> ${l}</label>`).join("")}</div>
    <div class="pgrid">
    <label class="f full"><span class="lab">${biz?"Business name":"Name"}<span class="req">*</span></span><input name="name" value="${esc(c.name||"")}" maxlength="80" autocomplete="off" required></label>
    <label class="f"><span class="lab">Mobile</span><input name="phone" type="tel" inputmode="tel" value="${esc(c.phone||"")}" maxlength="20" autocomplete="off" placeholder="10-digit mobile"></label>
    <label class="f"><span class="lab">Email</span><input name="email" type="email" inputmode="email" value="${esc(c.email||"")}" maxlength="120" autocomplete="off"></label>
    <label class="f full"><span class="lab">GSTIN${biz?"":" (optional)"}</span><input name="gstin" value="${esc(c.gstin||"")}" maxlength="15" autocomplete="off" autocapitalize="characters" placeholder="e.g. 27ABCDE1234F1Z5"></label></div>
    <p id="custErr" class="autherr"${c.err?"":" hidden"} role="alert">${esc(c.err||"")} ${dupBtn}</p>
    <div class="setactions"><button class="btn sm primary" type="submit">${c.id?"Save":c.from==="sell"?"Save and add to bill":"Save customer"}</button><button class="btn sm" type="button" data-act="custback">${c.id||c.from==="sell"?"Back":"Cancel"}</button></div></form>`;
}
function renderCustForm(){
  const c=store.custForm;
  $("#modalHost").innerHTML=sheet(c.id?"Edit customer":"New customer",`
    <div class="sh-head"><div class="sh-t"><h3>${c.id?"Edit customer":"New customer"}</h3><p>${c.from==="sell"&&!c.id?"They go on this bill once saved.":"Name is required; the rest helps you find them and bill businesses."}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    ${custFormHTML()}`);
}
/* The type switch relabels the form without losing what was typed */
export function custFormType(form){ store.custForm=Object.assign(store.custForm||{},formValues(form)); renderCustForm(); }
const formValues=form=>{const f=new FormData(form);return {name:String(f.get("name")||""),phone:String(f.get("phone")||""),email:String(f.get("email")||""),gstin:String(f.get("gstin")||""),type:String(f.get("type")||"individual")}};
export function saveCustomerForm(form){
  const cur=store.custForm||{from:"sell"}, v=formValues(form), r=saveCustomer(v,{id:cur.id});
  if(r.error){
    store.custForm=Object.assign({},cur,v,{err:r.error,field:r.field||"",dup:r.duplicate?{id:r.duplicate.id,name:r.duplicate.name}:null});
    renderCustForm(); const x=$(`#custForm [name=${r.field==="phone"?"phone":r.field||"name"}]`); if(x) x.focus();
    return;
  }
  flushSbQueue();
  const c=r.customer; store.custForm=null;
  if(r.created&&cur.from==="sell"){ setBillCustomer(c); closeModal(); renderAll(); toast(c.name+" added to the bill."); return; }
  renderAll(); openCustHistory(c.id); toast(r.created?"Customer saved.":"Customer details saved.");
}
export function custBack(){
  const c=store.custForm||{}; store.custForm=null;
  if(c.id) return openCustHistory(c.id);
  if(c.from==="page") return closeModal();
  renderCustPicker();
}
/* Pick a customer for the bill (from the Sell picker, a profile or the "Use …" button) */
export function pickCustomer(id){
  const c=customerRepository().get(id); if(!c) return;
  setBillCustomer(c); store.custForm=null; closeModal(); renderAll(); toast(c.name+" added to the bill.");
}

/* ---------- profile: details and purchase history ---------- */
export function openCustHistory(cid){
  const c=customerRepository().get(cid); if(!c) return;
  const h=purchaseHistory(cid);
  const billHTML=b=>`<button class="custbill" data-billview="${esc(b.id)}"><span class="cb-top"><b>${esc(b.no||"Bill")}</b><span>${esc(dayLab(dayKey(b.t)))} · ${esc(hhmm(b.t))}${b.pay?" · "+esc(b.pay):""}</span><b class="cb-tot">${inr(b.total)}</b></span>
    <span class="cb-items">${b.items.map(i=>`<span>${esc(i.name)}${i.label?" · "+esc(i.label):""} × ${i.q}</span>`).join("")}</span>
    <span class="cb-foot">${b.pieces} piece${b.pieces===1?"":"s"}${b.kind==="exchange"?" · exchange":""}${b.returned?` · ${inr(b.returned)} refunded`:""}</span></button>`;
  $("#modalHost").innerHTML=sheet(c.name,`
    <div class="sh-head"><span class="avatar lg">${esc(initials(c.name))}</span><div class="sh-t"><h3>${esc(c.name)}${badge(c)}</h3><p>${esc([c.phone,c.email].filter(Boolean).join(" · ")||"No contact details")}${c.gstin?`<br><span class="cgst">GSTIN ${esc(c.gstin)}</span>`:""}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="tmini cust3"><div><span>Bills</span><b>${h.count}</b></div><div><span>Total spent</span><b>${inr(h.spent)}</b></div><div><span>Last visit</span><b>${h.last?esc(dayLab(dayKey(h.last))):"—"}</b></div></div>
    <h4 class="custh">Purchase history</h4>
    <div class="custbills">${h.bills.length?h.bills.map(billHTML).join(""):`<p class="muted">No completed bills yet.</p>`}</div>
    <div class="setactions"><button class="btn sm" data-custedit="${esc(c.id)}">Edit details</button><button class="btn sm primary" data-custpick="${esc(c.id)}">${store.cartCust&&store.cartCust.id===c.id?"On the current bill":"Add to current bill"}</button></div>`);
}
export const customerTypeLabel = typeLabel;

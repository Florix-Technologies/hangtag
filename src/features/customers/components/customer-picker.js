// Choose/add a customer; customer history.
import { store } from '../../../shared/state/store.js';
import { custStats } from '../services/customer-stats.js';
import { D } from '../../inventory/services/ledger.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { saveCart, saveCustomers } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { uid } from '../../../shared/utils/ids.js';
import { initials, norm } from '../../../shared/utils/text.js';

export function openCustPicker(){ store.custQ=""; store.custForm=null; renderCustPicker(); const i=$("#custQ"); if(i) i.focus(); }
export function renderCustPicker(){
  const st=custStats(), q=norm(store.custQ).trim(), digits=q.replace(/\D/g,"");
  const list=Object.values(store.customers).filter(c=>!q||norm(c.name).includes(q)||(digits&&String(c.phone||"").replace(/\D/g,"").includes(digits))||norm(c.email).includes(q))
    .sort((a,b)=>((st[b.id]||{}).last||b.t||0)-((st[a.id]||{}).last||a.t||0)).slice(0,30);
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="Customer">
    <div class="sh-head"><div class="sh-t"><h3>Customer</h3><p>Optional. Pick someone or add them; you can skip this for walk-ins.</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    ${store.custForm?custFormHTML():`<div class="search"><input id="custQ" type="search" placeholder="Search name or phone" value="${esc(store.custQ)}" autocomplete="off"></div>
    <div class="custlist">${list.length?list.map(c=>{const s=st[c.id]||{bills:0,total:0};return `<div class="custrow"><button class="custpick" data-custpick="${esc(c.id)}"><span class="avatar sm">${esc(initials(c.name))}</span><span><b>${esc(c.name)}</b><small>${esc(c.phone||c.email||"")}${s.bills?" · "+s.bills+" bill"+(s.bills>1?"s":"")+" · "+inr(s.total):""}</small></span></button><button class="link xs" data-custhist="${esc(c.id)}">History</button></div>`}).join(""):`<p class="muted">${Object.keys(store.customers).length?"No one matches.":"No customers yet."}</p>`}</div>
    <div class="setactions"><button class="btn sm primary" data-act="custnew">+ Add new customer</button>${store.cartCust&&store.cartCust.name?`<button class="btn sm" data-act="nocust">Walk-in (no customer)</button>`:""}</div>`}
  </div></div>`;
}
export function custFormHTML(){
  const c=store.custForm||{};
  return `<form id="custForm" class="authform" novalidate><div class="pgrid">
    <label class="f"><span class="lab">Name<span class="req">*</span></span><input name="name" value="${esc(c.name||"")}" maxlength="80" autocomplete="off" required></label>
    <label class="f"><span class="lab">Phone</span><input name="phone" type="tel" inputmode="tel" value="${esc(c.phone||"")}" maxlength="20" autocomplete="off"></label>
    <label class="f full"><span class="lab">Email</span><input name="email" type="email" inputmode="email" value="${esc(c.email||"")}" maxlength="120" autocomplete="off"></label></div>
    <p id="custErr" class="autherr" hidden></p>
    <div class="setactions"><button class="btn sm primary" type="submit">${c.id?"Save":"Save and add to bill"}</button><button class="btn sm" type="button" data-act="custback">Back</button></div></form>`;
}
export function saveCustomerForm(form){
  const f=new FormData(form), name=String(f.get("name")||"").trim().replace(/\s+/g," "), phone=String(f.get("phone")||"").trim(), email=String(f.get("email")||"").trim();
  const err=$("#custErr"); const bad=m=>{err.textContent=m;err.hidden=false};
  if(!name) return bad("Enter the customer's name.");
  if(phone&&!/^[+0-9 ()-]{7,20}$/.test(phone)) return bad("Enter a valid phone number.");
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Enter a valid email address.");
  const dup=phone&&Object.values(store.customers).find(c=>c.id!==(store.custForm&&store.custForm.id)&&c.phone&&c.phone.replace(/\D/g,"")===phone.replace(/\D/g,""));
  if(dup) return bad(`${dup.name} already has this phone number.`);
  const editing=store.custForm&&store.custForm.id;
  const c=editing?Object.assign(store.customers[store.custForm.id],{name,phone,email}):{id:"c"+uid(),name,phone,email,t:Date.now()};
  store.customers[c.id]=c; saveCustomers(); enqueue({type:"cust",id:c.id,cust:c}); flushSbQueue();
  if(editing){ openCustHistory(c.id); toast("Customer saved."); return; }
  store.cartCust={id:c.id,name:c.name,phone:c.phone}; saveCart(); closeModal(); renderAll(); toast(c.name+" added to the bill.");
}
export function openCustHistory(cid){
  const c=store.customers[cid]; if(!c) return;
  const bills=D().sales.filter(s=>s.cust&&s.cust.id===cid).slice().reverse(), st=custStats()[cid]||{bills:0,total:0,last:0};
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="${esc(c.name)}">
    <div class="sh-head"><span class="avatar lg">${esc(initials(c.name))}</span><div class="sh-t"><h3>${esc(c.name)}</h3><p>${esc([c.phone,c.email].filter(Boolean).join(" · ")||"No contact details")}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="tmini cust3"><div><span>Bills</span><b>${st.bills}</b></div><div><span>Total spent</span><b>${inr(st.total)}</b></div><div><span>Last visit</span><b>${st.last?esc(dayLab(dayKey(st.last))):"—"}</b></div></div>
    <div class="custbills">${bills.length?bills.map(s=>`<button class="custbill" data-billview="${esc(s.id)}"><span>${esc(s.no)} · ${esc(dayLab(dayKey(s.t)))}${s.void?" · cancelled":""}</span><span>${s.items.reduce((a,i)=>a+i.q,0)} pcs · <b>${inr(s.total)}</b></span></button>`).join(""):`<p class="muted">No bills yet.</p>`}</div>
    <div class="setactions"><button class="btn sm" data-custedit="${esc(c.id)}">Edit details</button><button class="btn sm primary" data-custpick="${esc(c.id)}">Add to current bill</button></div>
  </div></div>`;
}

// Customers page: search by name or mobile, open a customer (details + purchase history), add a new one.
import { store } from '../../../shared/state/store.js';
import { searchCustomers } from '../../../domain/customers/customer.js';
import { custStats } from '../services/customer-stats.js';
import { customerRepository } from '../repositories/customer-repository.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { initials } from '../../../shared/utils/text.js';

export function renderCustomers(){
  const host=$("#custBody"); if(!host) return;
  if(!host.querySelector("#custSearch")){
    host.innerHTML=`<div class="custtools"><div class="search"><input id="custSearch" type="search" placeholder="Search name or mobile" autocomplete="off" inputmode="search" aria-label="Search customers"></div><button class="btn primary" data-act="custadd">+ Add customer</button></div><div id="custList" class="custpage"></div>`;
  }
  const i=$("#custSearch"); if(i&&document.activeElement!==i) i.value=store.custPageQ||"";
  renderCustomerList();
}
export function renderCustomerList(){
  const box=$("#custList"); if(!box) return;
  const st=custStats(), all=customerRepository().list(), q=store.custPageQ||"", list=searchCustomers(all,q,st);
  box.innerHTML=!all.length?`<div class="empty"><b>No customers yet</b><p>Add them here, or from the bill while selling. Their bills show up in their history.</p></div>`
    :`<p class="note">${list.length} of ${all.length} customer${all.length===1?"":"s"}</p>`+(list.length?list.map(c=>{const s=st[c.id]||{bills:0,total:0,last:0};return `<button class="custcard" data-custhist="${esc(c.id)}"><span class="avatar">${esc(initials(c.name))}</span>
      <span class="cc-main"><b>${esc(c.name)}${c.type==="business"?`<span class="ctype">Business</span>`:""}</b><small>${esc(c.phone||c.email||"No mobile")}</small></span>
      <span class="cc-side"><b>${s.bills?inr(s.total):""}</b><small>${s.bills?s.bills+" bill"+(s.bills===1?"":"s")+(s.last?" · "+esc(dayLab(dayKey(s.last))):""):"No bills yet"}</small></span></button>`}).join(""):`<p class="muted">No customer matches “${esc(q)}”.</p>`);
}

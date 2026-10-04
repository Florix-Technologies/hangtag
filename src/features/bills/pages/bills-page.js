// Bills is a first-class operational workspace: find a bill quickly, filter by period/status, then open the existing
// bill detail for print, PDF, send, return, exchange, credit note, e-invoice/e-way and cancellation actions.
import { dueAmtOf, payLabel } from '../../../domain/sales/payments.js';
import { store } from '../../../shared/state/store.js';
import { savePrefs } from '../../../shared/state/persistence.js';
import { emptyStateHTML, statusChip } from '../../../shared/ui/kit.js';
import { D } from '../../inventory/services/ledger.js';
import { outstandingAll } from '../../customers/services/customer-account.js';
import { $, esc } from '../../../shared/dom.js';
import { addDays, dayKey, dayLong, hhmm } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

const PERIODS = [['today','Today'],['yesterday','Yesterday'],['7d','7 days'],['30d','30 days'],['all','All time'],['custom','Custom']];
const STATUSES = [['all','All'],['paid','Paid'],['unpaid','Unpaid'],['credit','Credit'],['returned','Returned'],['cancelled','Cancelled']];
const dayRange = (key, now=Date.now()) => {
  const today=dayKey(now);
  if(key==='today') return {from:today,to:today};
  if(key==='yesterday'){const d=addDays(today,-1);return {from:d,to:d};}
  if(key==='7d') return {from:addDays(today,-6),to:today};
  if(key==='30d') return {from:addDays(today,-29),to:today};
  if(key==='custom') return {from:store.prefs.billFrom||today,to:store.prefs.billTo||today};
  return {from:'',to:''};
};
const hasReturns = s => !!((D().retBySale[s.id]||[]).length);
const unpaid = (s, owed) => !s.void && dueAmtOf(s)>0 && !!(s.cust&&s.cust.id&&owed[s.cust.id]>0);
export function billState(s, owed=outstandingAll()){
  if(s.void) return {key:'cancelled',label:'Cancelled',tone:'bad'};
  if(hasReturns(s)) return {key:'returned',label:'Returned',tone:'warn'};
  if(unpaid(s,owed)) return {key:'unpaid',label:'Unpaid',tone:'warn'};
  if(dueAmtOf(s)>0) return {key:'credit',label:'Credit',tone:'info'};
  return {key:'paid',label:'Paid',tone:'ok'};
}
const inPeriod=(s,r)=>!r.from||(dayKey(s.t)>=r.from&&dayKey(s.t)<=r.to);
const searchable=s=>[s.no,s.cust&&s.cust.name,s.cust&&s.cust.phone,...(s.items||[]).flatMap(i=>[i.n,i.sku,i.vl,i.s])].filter(Boolean).join(' ').toLowerCase();
export function visibleBills(){
  const range=dayRange(store.prefs.billPeriod||'30d'), status=store.prefs.billStatus||'all', q=String(store.billQuery||'').trim().toLowerCase(), owed=outstandingAll();
  return D().sales.slice().reverse().filter(s=>inPeriod(s,range)&&(status==='all'||billState(s,owed).key===status)&&(!q||searchable(s).includes(q)));
}
const periodLabel=()=>{const r=dayRange(store.prefs.billPeriod||'30d');return !r.from?'All time':r.from===r.to?dayLong(r.from):`${dayLong(r.from)} – ${dayLong(r.to)}`;};
const rowHTML=(s,owed)=>{
  const state=billState(s,owed), returned=(D().retBySale[s.id]||[]).reduce((n,r)=>n+(+r.value||0),0), items=(s.items||[]).slice(0,2).map(i=>i.n).join(', ')+(s.items&&s.items.length>2?` +${s.items.length-2}`:'');
  return `<button type="button" class="billrow" data-billview="${esc(s.id)}"><span class="billrow-main"><span class="billrow-top"><b>${esc(s.no||'Bill')}</b>${statusChip(state.label,state.tone)}</span><span class="billrow-meta">${esc(dayLong(dayKey(s.t)))} · ${esc(hhmm(s.t))} · ${esc(s.cust&&s.cust.name||'Walk-in')}</span><span class="billrow-items">${esc(items||'No items')}</span></span><span class="billrow-end"><b>${inrx(s.total)}</b><small>${esc(payLabel(s))}${returned?` · ${inr(returned)} returned`:''}</small></span><span class="billrow-open" aria-hidden="true">›</span></button>`;
};
export function renderBillsPage(){
  const host=$('#v-bills'); if(!host) return;
  const all=D().sales, list=visibleBills(), owed=outstandingAll(), live=all.filter(s=>!s.void), onCredit=live.filter(s=>dueAmtOf(s)>0), total=live.reduce((n,s)=>n+(+s.total||0),0);
  const custom=(store.prefs.billPeriod||'30d')==='custom';
  host.innerHTML=`<div class="viewhead bills-head"><div><h2 class="vt">Bills</h2><p>Find any sale, then print, send, return, exchange, create a credit note or prepare GST actions.</p></div><div class="vh-acts"><button type="button" class="btn primary" data-tab="sell">+ New sale</button></div></div>
    <div class="bills-tools card"><div class="search billsearch"><input id="billSearch" type="search" value="${esc(store.billQuery||'')}" placeholder="Search bill number, customer, phone or product" autocomplete="off" enterkeyhint="search" aria-label="Search bills"></div>
      <div class="billfilters" role="group" aria-label="Bill period">${PERIODS.map(([k,l])=>`<button type="button" class="chipbtn" data-billperiod="${k}" aria-pressed="${(store.prefs.billPeriod||'30d')===k}">${l}</button>`).join('')}</div>
      <div class="billcustom"${custom?'':' hidden'}><label class="f"><span class="lab">From</span><input id="billFrom" type="date" value="${esc(store.prefs.billFrom||dayKey(Date.now()))}"></label><label class="f"><span class="lab">To</span><input id="billTo" type="date" value="${esc(store.prefs.billTo||dayKey(Date.now()))}"></label></div>
      <div class="billfilters statuses" role="group" aria-label="Bill status">${STATUSES.map(([k,l])=>`<button type="button" class="chipbtn" data-billstatus="${k}" aria-pressed="${(store.prefs.billStatus||'all')===k}">${l}</button>`).join('')}</div></div>
    <div class="bill-kpis"><div><span>Bills</span><b>${live.length}</b></div><div><span>Sales</span><b>${inr(total)}</b></div><div><span>Credit bills</span><b>${onCredit.length}</b></div><div><span>Showing</span><b>${list.length}</b><small>${esc(periodLabel())}</small></div></div>
    <div class="bill-results"><div class="bill-results-head"><div><h3>${list.length} bill${list.length===1?'':'s'}</h3><p>${esc(periodLabel())}</p></div></div>${list.length?`<div class="billlist">${list.map(s=>rowHTML(s,owed)).join('')}</div>`:emptyStateHTML({icon:'receipt',title:'No bills found',text:store.billQuery?'Try another bill number, customer, phone or product.':'Change the period or status, or start a new sale.',actions:'<button type="button" class="btn primary" data-tab="sell">New sale</button>'})}</div>`;
}
let installed=false;
export function installBillsPageEvents(){
  if(installed) return; installed=true;
  document.addEventListener('input',e=>{if(e.target&&e.target.id==='billSearch'){store.billQuery=e.target.value;renderBillsPage();const i=$('#billSearch');if(i){i.focus({preventScroll:true});i.setSelectionRange(i.value.length,i.value.length);}}});
  document.addEventListener('click',e=>{const t=e.target&&e.target.closest&&e.target.closest('[data-billperiod],[data-billstatus]');if(!t)return;if(t.dataset.billperiod)store.prefs.billPeriod=t.dataset.billperiod;else store.prefs.billStatus=t.dataset.billstatus;savePrefs();renderBillsPage();});
  document.addEventListener('change',e=>{const t=e.target;if(!t)return;if(t.id==='billFrom'||t.id==='billTo'){store.prefs[t.id==='billFrom'?'billFrom':'billTo']=t.value;store.prefs.billPeriod='custom';savePrefs();renderBillsPage();}});
}

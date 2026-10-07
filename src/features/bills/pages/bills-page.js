// Bills: a workspace of its own. Find any bill by number, customer, phone or product, by period and state, then open it for
// print, PDF, send, return, exchange, credit notes, e-invoice and cancel (receipts/components/bill-view.js). A bill's state
// is the shop's own records (features/bills/services/bill-status.js); figures follow the period chosen.
import { payLabel, paymentsOf } from '../../../domain/sales/payments.js';
import { amountMatches, filterWords } from '../../../domain/search/search-query.js';
import { store } from '../../../shared/state/store.js';
import { savePrefs } from '../../../shared/state/persistence.js';
import { emptyStateHTML, statusChip } from '../../../shared/ui/kit.js';
import { D } from '../../inventory/services/ledger.js';
import { BILL_FILTERS, billChips, billContext, billFilters, billState } from '../services/bill-status.js';
import { loadRecentDeliveries } from '../../delivery/use-cases/send-invoice.js';
import { onDeliveryChange, sendFailedAgain } from '../../delivery/use-cases/auto-delivery.js';
import { toast } from '../../../shared/components/toast.js';
import { $, esc } from '../../../shared/dom.js';
import { addDays, dayKey, dayLong, hhmm } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';

const PERIODS = [['today','Today'],['yesterday','Yesterday'],['7d','7 days'],['30d','30 days'],['all','All time'],['custom','Custom']];
const PAGE = 50;
const dayRange = (key, now=Date.now()) => {
  const today=dayKey(now);
  if(key==='today') return {from:today,to:today};
  if(key==='yesterday'){const d=addDays(today,-1);return {from:d,to:d};}
  if(key==='7d') return {from:addDays(today,-6),to:today};
  if(key==='30d') return {from:addDays(today,-29),to:today};
  if(key==='custom') return {from:store.prefs.billFrom||today,to:store.prefs.billTo||today};
  return {from:'',to:''};
};
const inPeriod=(s,r)=>!r.from||(dayKey(s.t)>=r.from&&dayKey(s.t)<=r.to);
const searchable=s=>[s.no,s.cust&&s.cust.name,s.cust&&s.cust.phone,...(s.items||[]).flatMap(i=>[i.n,i.sku,i.vl,i.s])].filter(Boolean).join(' ').toLowerCase();
/* The state chosen (one this shop shows; "returned" was its earlier name) */
const chosen=()=>{const raw=store.prefs.billStatus||'all', k=raw==='returned'?'returns':raw;return billFilters().some(f=>f.key===k)?k:'all';};
/* The bills of the period chosen, newest first, each with its state */
function periodBills(ctx){
  const range=dayRange(store.prefs.billPeriod||'30d');
  return D().sales.filter(s=>inPeriod(s,range)).reverse().map(s=>({s,st:billState(s,ctx)}));
}
/* What Search narrowed the bills by, beyond the period, state and words: an amount and how they were paid (each shown as a
   chip that clears it) */
const extra=s=>(!store.billAmount||amountMatches(store.billAmount,s.total))&&(!store.billMethod||paymentsOf(s).some(p=>p.method===store.billMethod));
const qMatch=(s,q)=>!q||q.split(/\s+/).every(w=>searchable(s).includes(w));
/* The bills shown: the period, the state chosen, what is typed in the search, and Search's amount and method */
export function visibleBills(){
  const ctx=billContext(), f=BILL_FILTERS.find(x=>x.key===chosen())||BILL_FILTERS[0], q=String(store.billQuery||'').trim().toLowerCase();
  return periodBills(ctx).filter(x=>f.test(x.s,x.st)&&qMatch(x.s,q)&&extra(x.s)).map(x=>x.s);
}
/* Search's "Show in Bills": its period (today, yesterday, 7 / 30 days, or the exact dates), state, words, amount and method */
export function applyBillSearch(F){
  const P=F.period, keyOf={today:'today',yesterday:'yesterday','7d':'7d','30d':'30d'};
  if(!P){ store.prefs.billPeriod='all'; }
  else if(keyOf[P.key]) store.prefs.billPeriod=keyOf[P.key];
  else { store.prefs.billPeriod='custom'; store.prefs.billFrom=P.from; store.prefs.billTo=P.to; }
  store.prefs.billStatus=F.status&&billFilters().some(f=>f.key===F.status)?F.status:'all';
  store.billQuery=(F.words||[]).join(' '); store.billAmount=F.amount||null; store.billMethod=F.method||null; store.billLimit=PAGE;
  savePrefs();
}
const periodLabel=()=>{const r=dayRange(store.prefs.billPeriod||'30d');return !r.from?'All time':r.from===r.to?dayLong(r.from):`${dayLong(r.from)} – ${dayLong(r.to)}`;};
function rowHTML(s,st){
  const items=(s.items||[]).slice(0,2).map(i=>i.n).join(', ')+(s.items&&s.items.length>2?` +${s.items.length-2}`:'');
  const chips=billChips(s,st).map(([l,t])=>statusChip(l,t)).join('');
  const sub=[payLabel(s),st.owed?`${inr(st.owed)} due`:'',!st.owed&&st.returnedValue?`${inr(st.returnedValue)} returned`:''].filter(Boolean).join(' · ');
  return `<button type="button" class="billrow" data-billview="${esc(s.id)}" aria-label="Bill ${esc(s.no||'')}, ${esc(st.key==='unpaid'?`unpaid, ${inr(st.owed)} due`:st.label)}, ${esc(inrx(s.total))}"><span class="billrow-main"><span class="billrow-top"><b>${esc(s.no||'Bill')}</b><span class="billrow-chips">${chips}</span></span><span class="billrow-meta">${esc(dayLong(dayKey(s.t)))} · ${esc(hhmm(s.t))} · ${esc(s.cust&&s.cust.name||'Walk-in')}</span><span class="billrow-items">${esc(items||'No items')}</span></span><span class="billrow-end"><b${s.void?' class="void"':''}>${inrx(s.total)}</b><small>${esc(sub)}</small></span><span class="billrow-open" aria-hidden="true">›</span></button>`;
}
/* Search's amount and method filters, each a chip that clears it */
function searchChipsHTML(){
  const A=store.billAmount, M={cash:'Cash',upi:'UPI',card:'Card'}, chips=[];
  if(A) chips.push(`<button type="button" class="chipbtn on" data-billclear="amount" aria-label="Clear the amount filter">${esc(filterWords({amount:A},inr))} ✕</button>`);
  if(store.billMethod) chips.push(`<button type="button" class="chipbtn on" data-billclear="method" aria-label="Clear the payment filter">Paid by ${esc(M[store.billMethod]||store.billMethod)} ✕</button>`);
  return chips.length?`<div class="billfilters searchchips" role="group" aria-label="From Search">${chips.join('')}</div>`:'';
}
/* Receipts of the period that reached nobody: how many, with Send again (and the filter to see them) */
function unsentHTML(inP){
  const failed=inP.filter(x=>!x.s.void&&x.st.receipt&&x.st.receipt.state==='failed');
  if(!failed.length) return '';
  return `<div class="bill-alert" role="status"><span><b>${failed.length} receipt${failed.length===1?'':'s'} not sent</b> — the customer didn't get ${failed.length===1?'it':'them'}.</span><span class="bill-alert-acts"><button type="button" class="btn sm" data-billresend="${esc(failed.map(x=>x.s.id).join(','))}">Send again</button><button type="button" class="link xs" data-billstatus="unsent">Show them</button></span></div>`;
}
export function renderBillsPage(){
  const host=$('#v-bills'); if(!host) return;
  // what the server knows of the receipts sent (delivered, failed), at most once a minute
  loadRecentDeliveries().then(ch=>{ if(ch&&store.prefs.tab==='bills') renderBillsPage(); });
  const ctx=billContext(), inP=periodBills(ctx), live=inP.filter(x=>!x.s.void), sel=chosen(), q=String(store.billQuery||'').trim().toLowerCase();
  const filters=billFilters(), count=f=>inP.filter(x=>f.test(x.s,x.st)).length;
  const list=inP.filter(x=>(BILL_FILTERS.find(f=>f.key===sel)||BILL_FILTERS[0]).test(x.s,x.st)&&qMatch(x.s,q)&&extra(x.s));
  const limit=Math.max(PAGE,+store.billLimit||PAGE), shown=list.slice(0,limit);
  const sales=live.reduce((n,x)=>n+(+x.s.total||0),0), owed=live.reduce((n,x)=>n+(x.st.owed||0),0), returned=live.reduce((n,x)=>n+(x.st.returnedValue||0),0);
  const custom=(store.prefs.billPeriod||'30d')==='custom';
  host.innerHTML=`<div class="viewhead bills-head"><div><h2 class="vt">Bills</h2><p>Find a bill, then print, send, return, exchange or cancel it.</p></div><div class="vh-acts"><button type="button" class="btn primary" data-tab="sell">+ New sale</button></div></div>
    <div class="bills-tools card"><div class="search billsearch"><input id="billSearch" type="search" value="${esc(store.billQuery||'')}" placeholder="Bill number, customer, phone or product" autocomplete="off" enterkeyhint="search" aria-label="Search bills"></div>
      <div class="billfilters" role="group" aria-label="Period">${PERIODS.map(([k,l])=>`<button type="button" class="chipbtn" data-billperiod="${k}" aria-pressed="${(store.prefs.billPeriod||'30d')===k}">${l}</button>`).join('')}</div>
      <div class="billcustom"${custom?'':' hidden'}><label class="f"><span class="lab">From</span><input id="billFrom" type="date" value="${esc(store.prefs.billFrom||dayKey(Date.now()))}"></label><label class="f"><span class="lab">To</span><input id="billTo" type="date" value="${esc(store.prefs.billTo||dayKey(Date.now()))}"></label></div>
      <div class="billfilters statuses" role="group" aria-label="State">${filters.map(f=>{const n=f.key==='all'?inP.length:count(f);return `<button type="button" class="chipbtn" data-billstatus="${f.key}" aria-pressed="${sel===f.key}">${esc(f.label)}<span class="cnt">${n}</span></button>`;}).join('')}</div></div>
    ${searchChipsHTML()}${unsentHTML(inP)}<div class="bill-kpis" aria-label="${esc(periodLabel())}"><div><span>Bills</span><b>${live.length}</b></div><div><span>Sales</span><b>${inr(sales)}</b></div><div><span>Unpaid</span><b${owed>0?' class="warn"':''}>${inr(owed)}</b></div><div><span>Returned</span><b>${inr(returned)}</b></div></div>
    <div class="bill-results"><div class="bill-results-head"><div><h3>${list.length} bill${list.length===1?'':'s'}</h3><p>${esc(periodLabel())}</p></div></div>${list.length?`<div class="billlist">${shown.map(x=>rowHTML(x.s,x.st)).join('')}</div>${list.length>shown.length?`<div class="billmore"><button type="button" class="btn" data-billmore>Show ${Math.min(PAGE,list.length-shown.length)} more <span class="muted">· ${shown.length} of ${list.length}</span></button></div>`:''}`:emptyStateHTML({icon:'receipt',title:'No bills found',text:q?'Try another bill number, customer, phone or product.':'Change the period or state, or start a new sale.',actions:'<button type="button" class="btn primary" data-tab="sell">New sale</button>'})}</div>`;
}
let installed=false;
export function installBillsPageEvents(){
  if(installed) return; installed=true;
  document.addEventListener('input',e=>{if(e.target&&e.target.id==='billSearch'){store.billQuery=e.target.value;store.billLimit=PAGE;renderBillsPage();const i=$('#billSearch');if(i){i.focus({preventScroll:true});i.setSelectionRange(i.value.length,i.value.length);}}});
  // a receipt queued, sent or failed while the list is open: its chip follows
  onDeliveryChange(()=>{ if(store.prefs.tab==='bills') renderBillsPage(); });
  document.addEventListener('click',e=>{
    const bc=e.target&&e.target.closest&&e.target.closest('[data-billclear]');
    if(bc){ if(bc.dataset.billclear==='amount') store.billAmount=null; else store.billMethod=null; store.billLimit=PAGE; renderBillsPage(); return; }
    const rs=e.target&&e.target.closest&&e.target.closest('[data-billresend]');
    if(rs){ const n=sendFailedAgain(rs.dataset.billresend.split(',').filter(Boolean)); toast(n?`Sending ${n} receipt${n===1?'':'s'} again.`:'Nothing to send again.'); renderBillsPage(); return; }
    const t=e.target&&e.target.closest&&e.target.closest('[data-billperiod],[data-billstatus],[data-billmore]');if(!t)return;
    if(t.hasAttribute('data-billmore')){store.billLimit=(Math.max(PAGE,+store.billLimit||PAGE))+PAGE;renderBillsPage();return;}
    if(t.dataset.billperiod)store.prefs.billPeriod=t.dataset.billperiod;else store.prefs.billStatus=t.dataset.billstatus;
    store.billLimit=PAGE;savePrefs();renderBillsPage();
  });
  document.addEventListener('change',e=>{const t=e.target;if(!t)return;if(t.id==='billFrom'||t.id==='billTo'){store.prefs[t.id==='billFrom'?'billFrom':'billTo']=t.value;store.prefs.billPeriod='custom';store.billLimit=PAGE;savePrefs();renderBillsPage();}});
}

// Event Mode screens: the Events card on Reports (create, change, close / reopen, delete one without bills, summary), and the
// "Selling at" choice on the Sell screen (each device chooses the store or one active event).
import { EVENT_STATUS, STORE, sortEvents } from '../../../domain/events/event.js';
import { PAY_LABELS } from '../../../domain/sales/payments.js';
import { store } from '../../../shared/state/store.js';
import { currentSelling } from '../services/selling-context.js';
import { eventSummary } from '../services/event-summary.js';
import { deleteEvent, eventBillCount, saveEvent, setEventStatus, setSellingAt } from '../use-cases/manage-events.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';
import { renderAll } from '../../../shared/ui/render.js';
import { refuse } from '../../shop/services/access.js';

const dates=e=>e.start===e.end?dayLab(e.start):dayLab(e.start)+" – "+dayLab(e.end);
/* Reports → Events */
export function eventsCardHTML(){
  const evs=sortEvents(Object.values(store.events||{}));
  return `${evs.length?`<div class="vperf">${evs.map(e=>{const n=eventBillCount(e.id);return `<div class="vp-row"><span class="vp-n"><b>${esc(e.name)}</b> <span class="btag${e.status==="closed"?"":" c"}">${e.status==="closed"?"Closed":"Active"}</span><br><small class="note">${esc(dates(e))}${e.place?" · "+esc(e.place):""} · ${n} bill${n===1?"":"s"}</small></span>
    <span class="setactions" style="margin:0"><button class="btn xs" data-evsum="${esc(e.id)}">Summary</button><button class="btn xs" data-evedit="${esc(e.id)}">Edit</button></span></div>`}).join("")}</div>`
    :`<p class="muted">Selling at a pop-up, fair or exhibition? Create an event, choose it on the phones at the stall, and its takings are reported apart. Stock and the books stay the shop's.</p>`}
    <div class="setactions"><button class="btn xs" data-act="evnew">+ New event</button></div>`;
}
export function openEventForm(id){
  if(refuse("manage_settings","change events"))return;
  const e=id?store.events[id]:null, today=dayKey(Date.now());
  store.evForm={id:e?e.id:null,name:e?e.name:"",start:e?e.start:today,end:e?e.end:today,place:e?e.place:"",err:""};
  renderEventForm();
}
export function renderEventForm(){
  const F=store.evForm; if(!F) return;
  const e=F.id?store.events[F.id]:null, n=e?eventBillCount(e.id):0;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="${e?"Edit event":"New event"}">
    <div class="sh-head"><div class="sh-t"><h3>${e?"Edit event":"New event"}</h3><p>Bills made on a phone selling at this event are tagged with it. Stock, prices and the books stay the shop's.</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <form id="evForm" class="custform">
      <label class="f">Name<input name="name" maxlength="80" value="${esc(F.name)}" placeholder="Diwali pop-up, Mumbai" required></label>
      <div class="frow"><label class="f">Starts<input type="date" name="start" value="${esc(F.start)}" required></label><label class="f">Ends<input type="date" name="end" value="${esc(F.end)}" required></label></div>
      <label class="f">Place (optional)<input name="place" maxlength="120" value="${esc(F.place)}"></label>
      <p id="evErr" class="autherr"${F.err?"":" hidden"}>${esc(F.err)}</p>
      <div class="setactions"><button class="btn sm primary" type="submit">${e?"Save":"Create event"}</button>
        ${e?(e.status===EVENT_STATUS.ACTIVE?`<button type="button" class="btn sm" data-evclose="${esc(e.id)}">Close event</button>`:`<button type="button" class="btn sm" data-evopen="${esc(e.id)}">Reopen</button>`):""}
        ${e&&!n?`<button type="button" class="btn sm danger" data-evdel="${esc(e.id)}">Delete</button>`:""}</div>
      ${e&&n?`<p class="note">It has ${n} bill${n===1?"":"s"}, so it can be closed but not deleted.</p>`:""}
    </form></div></div>`;
}
export function submitEventForm(form){
  const F=store.evForm; if(!F) return;
  const v=k=>(form.elements[k]||{}).value||"";
  Object.assign(F,{name:v("name"),start:v("start"),end:v("end"),place:v("place")});
  const r=saveEvent({id:F.id||undefined,name:F.name,start:F.start,end:F.end,place:F.place});
  if(r.error){F.err=r.error;renderEventForm();return}
  store.evForm=null; closeModal(); renderAll();
  toast(F.id?"Event saved.":`Event created. Choose "${r.event.name}" under Selling at on the phones at the stall.`);
}
export function eventStatusAction(id,status){
  if(refuse("manage_settings","change events"))return;
  const r=setEventStatus(id,status); if(r.error){toast(r.error);return}
  store.evForm=null; closeModal(); renderAll();
  toast(status===EVENT_STATUS.CLOSED?"Event closed. New bills are no longer tagged with it.":"Event reopened.");
}
export function deleteEventAction(id){
  if(refuse("manage_settings","change events"))return;
  const r=deleteEvent(id); if(r.error){toast(r.error);return}
  store.evForm=null; closeModal(); renderAll(); toast("Event deleted.");
}
/* An event's summary sheet */
export function openEventSummary(id){
  const e=store.events[id]; if(!e) return;
  const S=eventSummary(e), K=S.K, P=S.profit, row=(a,b,n)=>`<div class="row"><span>${a}${n?` <small class="note">${n}</small>`:""}</span><span class="tnum">${b}</span></div>`;
  const list=(g,name)=>g.length?g.map(x=>row(esc(name(x)),x.q+" pcs · "+inrx(x.amt))).join(""):`<p class="muted">Nothing sold.</p>`;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="Event summary">
    <div class="sh-head"><div class="sh-t"><h3>${esc(e.name)}</h3><p>${esc(dates(e))}${e.place?" · "+esc(e.place):""} · ${e.status==="closed"?"closed":"active"}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="rt-sum">${row("Total sales",inrx(K.total),K.returns?"after "+inrx(K.returns)+" returns":"")}${row("Bills",K.bills)}${row("Pieces",K.pieces)}${row("Net sales (without GST)",inrx(K.netSales))}${row("GST",inrx(S.gst.tax),"CGST "+inrx(S.gst.cgst)+" · SGST "+inrx(S.gst.sgst)+" · IGST "+inrx(S.gst.igst))}
      ${["cash","upi","card"].map(k=>row(PAY_LABELS[k],inrx(S.pay.methods[k].net),S.pay.methods[k].refunds?inrx(S.pay.methods[k].refunds)+" refunded":"")).join("")}
      ${row("Gross profit",P.covered?inrx(P.grossProfit):"—",P.complete?(P.margin==null?"":"margin "+P.margin+"%"):`cost known for ${Math.round(P.coverage*100)}% of sales`)}
      ${S.expenses.total?row("Expenses paid in cash",inrx(S.expenses.total),S.expenses.byCategory.map(x=>`${x.category} ${inrx(x.amount)}`).join(" · ")):""}
      ${S.expenses.total&&P.covered?row("Profit after expenses",inrx(P.grossProfit-S.expenses.total),P.complete?"":"gross profit covers only the pieces with a cost"):""}
      ${S.postEventReturns?row("Returns after the event",S.postEventReturns):""}${S.cancelled?row("Cancelled bills (left out)",S.cancelled):""}</div>
    <div class="setsec"><h4>Top products</h4><div class="rt-sum">${list(S.products,x=>x.first.name)}</div></div>
    <div class="setsec"><h4>Top variants</h4><div class="rt-sum">${list(S.variants,x=>x.first.name+(x.first.vl?" · "+x.first.vl:""))}</div></div>
    <div class="setactions"><button class="btn sm" data-repevent="${esc(e.id)}" data-tab="report">See it on Reports</button><button class="btn sm" data-modal-close>Close</button></div>
  </div></div>`;
}
/* Sell screen: what this device is selling at, with a warning when that event is closed or out of its dates */
export function sellingBannerHTML(){
  const evs=Object.values(store.events||{}).filter(e=>e.status===EVENT_STATUS.ACTIVE);
  const C=currentSelling();
  if(!evs.length&&!C.notice) return "";
  let warn="";
  if(C.notice==="closed") warn=`<span class="note">${ICON.warn} ${esc(C.closed.name)} was closed — now selling at the store.</span>`;
  else if(C.outside) warn=`<span class="note">${ICON.warn} Today is outside ${esc(C.event.name)}'s dates (${esc(dates(C.event))}). <button type="button" class="link" data-sellat="${STORE}">Switch to the store</button></span>`;
  return `<div class="sellat"><label class="f inline">Selling at <select id="sellAt" aria-label="Selling at"><option value="${STORE}">Store</option>${evs.map(e=>`<option value="${esc(e.id)}"${C.event&&C.event.id===e.id?" selected":""}>${esc(e.name)}</option>`).join("")}</select></label>${warn}</div>`;
}
export function chooseSellingAt(id){
  const r=setSellingAt(id); if(r.error){toast(r.error);return}
  renderAll();
  toast(id&&id!==STORE?`Bills on this device are now tagged with ${store.events[id].name}.`:"Selling at the store.");
}

// Sync panel (tap the sync status): what is still waiting to upload and why, and the changes the database refused, to send
// again or (never a bill) discard.
import { canDiscard, dependsOn, numberTaken, waitingKeys } from '../../../domain/sync/queue-rules.js';
import { store } from '../../../shared/state/store.js';
import { discardReview, flushSbQueue, renumberReview, retryReview } from '../services/outbox.js';
import { toast } from '../../../shared/components/toast.js';
import { products } from '../../products/services/catalog.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { agoText, dtLong } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';

const TYPE={cashmove:"Cash entry",dayclose:"Day close",sale:"Bill",void:"Cancel / restore bill",return:"Return",prod:"Product",proddel:"Product removed",img:"Photo",move:"Stock change",cust:"Customer",
  event:"Event",eventdel:"Event removed",settings:"Settings",logo:"Receipt logo",allsales:"All bills (full upload)"};
/* What a queued item is, in words */
export function itemLabel(q){
  const what=TYPE[q.type]||q.type;
  if(q.type==="sale"&&q.sale) return `${what} ${q.sale.no||""} · ${inrx(q.sale.total)}`;
  if(q.type==="return"&&q.ret) return `${what} ${q.ret.no||""} · ${inrx(q.ret.value)} (${q.ret.items.map(i=>i.n+" × "+i.q).join(", ")})`;
  if(q.type==="cust"&&q.cust) return `${what} ${q.cust.name}`;
  if(q.type==="event"&&q.ev) return `${what} ${q.ev.name}`;
  if(q.type==="prod"){ const p=products().find(x=>x.id===q.id); return `${what} ${p?p.name:q.id}`; }
  if(q.type==="cashmove"&&q.move) return `${what} ${inrx(q.move.amount)} · ${q.move.reason||""}`;
  if(q.type==="dayclose"&&q.close) return `${what} ${q.close.day} · counted ${inrx(q.close.counted)}`;
  if(q.type==="move"&&q.move) return `${what} ${q.move.q>0?"+":""}${q.move.q}`;
  return what;
}
export function openSyncPanel(){ store.syncOpen=true; renderSyncPanel(); }
export function renderSyncPanel(){
  if(!store.syncOpen) return;
  const Q=store.sbOfflineQueue, R=store.syncReview||[], waiting=waitingKeys(Q,R);
  const status=store.sbStatus==="connected"?"Connected":store.sbStatus==="update"?"Database update needed":store.sbStatus==="connecting"?"Connecting…":"Offline — everything is kept on this device";
  const qRows=Q.map(q=>{const blocked=dependsOn(q).some(k=>waiting.has(k));
    return `<div class="retline"><b>${esc(itemLabel(q))}</b>${q.tries?` · tried ${q.tries}×`:""}${blocked?" · waits for its bill or product to upload first":""}${q.err?`<br><span class="note">${esc(q.err)}</span>`:""}</div>`}).join("");
  const rRows=R.map((r,i)=>`<div class="retline" data-review="${i}"><b>${esc(itemLabel(r.item))}</b> · ${esc(dtLong(r.t))}<br><span class="note">${esc(r.err||"Refused")}</span>
    <div class="setactions" style="margin-top:6px">${numberTaken(r)?`<button class="btn xs primary" data-syncrenumber="${i}">Give it a new number and send</button>`:""}<button class="btn xs" data-syncretry="${i}">Send again</button>${canDiscard(r.item)?`<button class="btn xs danger" data-syncdiscard="${i}">Discard</button>`:`<span class="note">A bill is never discarded: it stays on this device.</span>`}</div></div>`).join("");
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="Sync">
    <div class="sh-head"><div class="sh-t"><h3>Sync</h3><p>${esc(status)}${store.lastSyncAt?" · last fully synced "+esc(agoText(store.lastSyncAt)):""}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="setsec" style="border-top:0;padding-top:0"><h4>Waiting to upload (${Q.length})</h4>${Q.length?qRows:`<p class="okline">${ICON.ok}Nothing waiting.</p>`}
      ${Q.length&&store.sbStatus==="connected"?`<div class="setactions"><button class="btn sm" data-act="syncnow">Upload now</button></div>`:""}</div>
    <div class="setsec"><h4>Needs review (${R.length})</h4>${R.length?`<p class="note">The database refused these (for example, the pieces were already returned on another device). They are kept here, not applied, until you send them again or discard them.</p>${rRows}`:`<p class="okline">${ICON.ok}Nothing refused.</p>`}</div>
  </div></div>`;
}
export async function syncNow(){ await flushSbQueue(); renderSyncPanel(); }
export function syncRetry(i){ retryReview(i); renderSyncPanel(); }
export function syncDiscard(i){ discardReview(i); renderSyncPanel(); }
export function syncRenumber(i){ const r=renumberReview(i); toast(r.error||`New number ${r.no}: sending it again.`); renderSyncPanel(); }

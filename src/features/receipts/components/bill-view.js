// Bill view dialog: the receipt or A4 invoice, its payments, returns, printing and sending to the customer.
import { lineLabel } from '../../../domain/catalog/options.js';
import { PAY_LABELS } from '../../../domain/sales/payments.js';
import { billMoney } from '../../finance/services/books-data.js';
import { D } from '../../inventory/services/ledger.js';
import { receiptHTML } from './receipt-view.js';
import { saleReturns } from '../services/receipt-model.js';
import { historyHTML, refreshHistory, sendBoxHTML } from '../../delivery/components/send-actions.js';
import { printStateHTML } from '../../printing/components/print-actions.js';
import { store } from '../../../shared/state/store.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';

/* ================= bill view (from Reports, the last bill, customers) ================= */

export function openBillView(sid,paper){
  const s=D().saleById[sid]; if(!s) return;
  const view=paper||(store.settings.paper==="a4"?"a4":"80mm");
  const M=billMoney(s);
  const money=`<div class="setsec"><h4>Payments</h4>${M.txns.length?M.txns.map(x=>`<div class="retline" data-txn="${esc(x.id)}"><b>${esc(PAY_LABELS[x.method]||x.method)}</b> · ${x.kind==="refund"?"refund −":""}${inrx(x.amount)}${x.ref?" · ref "+esc(x.ref):""}${x.change?` · received ${inrx(x.received)}, change ${inrx(x.change)}`:""}${x.status==="cancelled"?" · cancelled":""}</div>`).join(""):`<p class="note">Nothing was collected on this bill.</p>`}<p class="note">${M.ok?(s.void?"Cancelled — its payments are out of the cash and bank books.":`Payments match the amount due (${inrx(M.due)}).`):`Payments (${inrx(M.received)}) don't match the amount due (${inrx(M.due)}).`}${+s.dueAmt>0?` Left on ${esc(s.cust&&s.cust.name||"the customer")}'s account: <b>${inrx(s.dueAmt)}</b>.`:""}</p></div>`;
  const rets=saleReturns(sid), canReturn=!s.void&&s.items.some((i,k)=>i.q-(D().retLine[s.id+"|"+(i.ln!=null?i.ln:k)]||0)>0);
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet billview${view==="a4"?" wide":""}" role="dialog" aria-modal="true" aria-label="Bill ${esc(s.no)}">
    <div class="sh-head"><div class="sh-t"><h3>Bill ${esc(s.no)}</h3><p>${esc(dtLong(s.t))}${s.void?" · cancelled"+(s.voidReason?": "+esc(s.voidReason):""):""}${s.kind==="exchange"?" · exchange":""}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="seg billpaper" role="group" aria-label="Show as"><button type="button" data-billpaper="80mm:${esc(s.id)}" aria-pressed="${view!=="a4"}">Receipt</button><button type="button" data-billpaper="a4:${esc(s.id)}" aria-pressed="${view==="a4"}">A4 invoice</button></div>
    <div class="rcpt-prev${view==="a4"?" a4prev":""}">${receiptHTML(s,view)}</div>
    <div class="setactions"><button class="btn sm" data-print="${esc(s.id)}">Print</button><button class="btn sm" data-dlreceipt="${esc(s.id)}">Download</button>${navigator.share?`<button class="btn sm" data-share="${esc(s.id)}">Share</button>`:""}
    ${canReturn?`<button class="btn sm" data-return="${esc(s.id)}">Return / exchange</button>`:""}
    ${s.void?`<button class="btn sm" data-unvoid="${esc(s.id)}">Restore bill</button>`:rets.length?"":`<button class="btn sm danger" data-void="${esc(s.id)}">Cancel bill</button>`}</div>
    ${printStateHTML(s.id)}
    ${sendBoxHTML(s)}
    <div data-dlhist="${esc(s.id)}">${historyHTML(s.id)}</div>
    ${money}
    ${rets.length?`<div class="setsec"><h4>Returns and exchanges</h4>${retLinesHTML(s)}${rets.map(r=>{const tax=(r.items||[]).reduce((a,i)=>a+(i.cgst||0)+(i.sgst||0)+(i.igst||0),0),ex=r.ex&&D().sales.find(x=>x.ex===r.ex&&x.kind==="exchange");
      return `<div class="retline" data-ret="${esc(r.id)}"><b>${r.kind==="exchange"?"Exchange":"Return"}${r.no?" · credit note "+esc(r.no):""}</b> · ${esc(dtLong(r.t))}<br>${r.items.map(i=>esc(i.n+(lineLabel(i)?" "+lineLabel(i):""))+" × "+i.q+(i.restock===false?" (not for resale)":"")).join(", ")} · ${inrx(r.value)}${tax?" incl. GST "+inrx(tax):""}${r.ro?" · round off "+inrx(r.ro):""}${r.refund?" · refunded "+inrx(r.refund)+" ("+(PAY_LABELS[r.pay]||r.pay)+(r.providerRefund?", through the provider · "+esc(r.providerRefund):"")+")":""}${ex?` · new bill <button class="link" data-billview="${esc(ex.id)}">${esc(ex.no)}</button>`:""}${r.note?`<br><span class="note">${esc(r.note)}</span>`:""}</div>`}).join("")}</div>`:""}
  </div></div>`;
  refreshHistory(sid);
}
/* Each line of the bill with how much of it came back ("1 of 2 returned") */
function retLinesHTML(s){
  const L=s.items.map((i,k)=>{const n=D().retLine[s.id+"|"+(i.ln!=null?i.ln:k)]||0;return n?`${esc(i.n+(lineLabel(i)?" "+lineLabel(i):""))}: ${n} of ${i.q} returned`:""}).filter(Boolean);
  return L.length?`<p class="note">${L.join(" · ")}</p>`:"";
}

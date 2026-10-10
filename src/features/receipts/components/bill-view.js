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
import { userLabel } from '../../shop/services/access.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { gstDocsHTML } from '../../commerce/components/gst-documents.js';
import { usesEinvoice, usesEway } from '../../commerce/use-cases/gst-documents.js';
import { can } from '../../shop/services/access.js';
import { actionsMenuHTML, statusChip } from '../../../shared/ui/kit.js';
import { billChips, billState } from '../../bills/services/bill-status.js';
import { documentFrameHTML, fitDocFrames } from './doc-render.js';
import { docOptions, downloadDocumentPdf, printDocument, shareDocumentPdf } from './doc-actions.js';
import { creditNoteModel, invoiceModel } from '../services/doc-models.js';

/* ================= bill view (from Reports, the last bill, customers) ================= */

/* The bill's actions: Print, PDF and Send on the bar; the rest in one menu — only what can be done with this bill, by this
   person: return, exchange, its credit notes, e-invoice / e-way bill, share, the receipt as an image, cancel or restore */
function billActions(s,canReturn,rets){
  const id=esc(s.id), gst=!s.void&&(can("create_sale")||can("view_reports"));
  return actionsMenuHTML("bill-"+s.id,[
    canReturn?{label:"Return",hint:"Refund, with a credit note",icon:"convert",attrs:`data-return="${id}"`}:null,
    canReturn?{label:"Exchange",hint:"Swap for other items",icon:"refresh",attrs:`data-exchange="${id}"`}:null,
    ...rets.filter(r=>r.no).map(r=>({label:"Credit note "+r.no,hint:"Print or download",icon:"doc",attrs:`data-cnopen="${esc(r.id)}"`})),
    gst&&usesEinvoice()?{label:"E-Invoice",hint:"Readiness and JSON export",icon:"doc",attrs:`data-gstopen="einv|${id}"`}:null,
    gst&&usesEway()?{label:"E-Way Bill",hint:"Transport details and JSON export",icon:"truck",attrs:`data-gstopen="eway|${id}"`}:null,
    {sep:true},
    {label:"Share",icon:"share",attrs:navigator.share?`data-share="${id}"`:`data-billsharepdf="${id}"`},
    {label:"Download receipt image",icon:"receipt",attrs:`data-dlreceipt="${id}"`},
    {sep:true},
    s.void?{label:"Restore bill",icon:"refresh",attrs:`data-unvoid="${id}"`}:rets.length||s.kind==="exchange"?null:{label:"Cancel bill",hint:"Asks for the reason",icon:"x",danger:true,attrs:`data-void="${id}"`},
  ],{label:"More"});
}
export function openBillView(sid,paper){
  const s=D().saleById[sid]; if(!s) return;
  const view=paper||(store.settings.paper==="a4"?"a4":"80mm");
  const M=billMoney(s);
  const money=`<div class="setsec"><h4>Payments</h4>${M.txns.length?M.txns.map(x=>`<div class="retline" data-txn="${esc(x.id)}"><b>${esc(PAY_LABELS[x.method]||x.method)}</b> · ${x.kind==="refund"?"refund −":""}${inrx(x.amount)}${x.ref?" · ref "+esc(x.ref):""}${x.change?` · received ${inrx(x.received)}, change ${inrx(x.change)}`:""}${x.status==="cancelled"?" · cancelled":""}</div>`).join(""):`<p class="note">Nothing was collected on this bill.</p>`}<p class="note">${M.ok?(s.void?"Cancelled — its payments are out of the cash and bank books.":`Payments match the amount due (${inrx(M.due)}).`):`Payments (${inrx(M.received)}) don't match the amount due (${inrx(M.due)}).`}${+s.dueAmt>0?` Left on ${esc(s.cust&&s.cust.name||"the customer")}'s account: <b>${inrx(s.dueAmt)}</b>.`:""}</p></div>`;
  const st=billState(s), rets=saleReturns(sid), canReturn=!s.void&&can("perform_return")&&s.items.some((i,k)=>i.q-(D().retLine[s.id+"|"+(i.ln!=null?i.ln:k)]||0)>0);
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet billview${view==="a4"?" wide":""}" role="dialog" aria-modal="true" aria-label="Bill ${esc(s.no)}">
    <div class="sh-head"><div class="sh-t"><h3>Bill ${esc(s.no)} <span class="billchips">${billChips(s,st).map(([l,t])=>statusChip(l,t)).join("")}</span></h3>${st.owed?`<p class="billowed" data-billowed>${inr(st.owed)} still to collect from ${esc(s.cust&&s.cust.name||"the customer")}</p>`:""}<p>${esc(dtLong(s.t))}${s.user?" · by "+esc(userLabel(s.user)):""}${s.void?" · cancelled"+(s.voidReason?": "+esc(s.voidReason):""):""}${s.kind==="exchange"?" · exchange":""}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="billtools"><div class="seg billpaper" role="group" aria-label="Show as"><button type="button" data-billpaper="80mm:${esc(s.id)}" aria-pressed="${view!=="a4"}">Receipt</button><button type="button" data-billpaper="a4:${esc(s.id)}" aria-pressed="${view==="a4"}">A4 ${s.tax>0?"tax invoice":"bill"}</button></div>
      <div class="btnrow"><button class="btn" data-billpdf="${esc(s.id)}">PDF</button>${s.void?"":`<button class="btn" data-gosend="${esc(s.id)}">Send</button>`}${billActions(s,canReturn,rets)}<button class="btn primary" data-print="${esc(s.id)}" data-paper="${view}">Print</button></div></div>
    <div class="rcpt-prev${view==="a4"?" a4prev":""}">${view==="a4"?documentFrameHTML(invoiceModel(s),docOptions()):receiptHTML(s,view)}</div>
    ${printStateHTML(s.id)}
    <div id="sendBox-${esc(s.id)}">${sendBoxHTML(s)}</div>
    ${gstDocsHTML(s)}
    <div data-dlhist="${esc(s.id)}">${historyHTML(s.id)}</div>
    ${money}
    ${rets.length?`<div class="setsec"><h4>Returns and exchanges</h4>${retLinesHTML(s)}${rets.map(r=>{const tax=(r.items||[]).reduce((a,i)=>a+(i.cgst||0)+(i.sgst||0)+(i.igst||0),0),ex=r.ex&&D().sales.find(x=>x.ex===r.ex&&x.kind==="exchange");
      return `<div class="retline" data-ret="${esc(r.id)}"><b>${r.kind==="exchange"?"Exchange":"Return"}${r.no?" · credit note "+esc(r.no):""}</b> · ${esc(dtLong(r.t))}<br>${r.items.map(i=>esc(i.n+(lineLabel(i)?" "+lineLabel(i):""))+" × "+i.q+(i.restock===false?" (not for resale)":"")).join(", ")} · ${inrx(r.value)}${tax?" incl. GST "+inrx(tax):""}${r.ro?" · round off "+inrx(r.ro):""}${r.refund?" · refunded "+inrx(r.refund)+" ("+(PAY_LABELS[r.pay]||r.pay)+(r.providerRefund?", through the provider · "+esc(r.providerRefund):"")+")":""}${ex?` · new bill <button class="link" data-billview="${esc(ex.id)}">${esc(ex.no)}</button>`:""}${r.no?` · <button type="button" class="link" data-cnopen="${esc(r.id)}">Credit note</button>`:""}${r.note?`<br><span class="note">${esc(r.note)}</span>`:""}</div>`}).join("")}</div>`:""}
  </div></div>`;
  refreshHistory(sid);
  fitDocFrames($("#modalHost"));
}
/* Each line of the bill with how much of it came back ("1 of 2 returned") */
function retLinesHTML(s){
  const L=s.items.map((i,k)=>{const n=D().retLine[s.id+"|"+(i.ln!=null?i.ln:k)]||0;return n?`${esc(i.n+(lineLabel(i)?" "+lineLabel(i):""))}: ${n} of ${i.q} returned`:""}).filter(Boolean);
  return L.length?`<p class="note">${L.join(" · ")}</p>`:"";
}
/* A return's credit note: print or download it (the same template as invoices) */
export function openCreditNote(retId){
  const r=(D().rets||[]).find(x=>x.id===retId); if(!r) return;
  const m=creditNoteModel(r);
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet billview wide" role="dialog" aria-modal="true" aria-label="Credit note ${esc(r.no||"")}">
    <div class="sh-head"><div class="sh-t"><h3>Credit note ${esc(r.no||"")}</h3><p>${esc(dtLong(r.t))}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="billtools"><span></span><div class="btnrow"><button class="btn" data-cnpdf="${esc(r.id)}">Download PDF</button><button class="btn" data-cnshare="${esc(r.id)}">Share</button><button class="btn primary" data-cnprint="${esc(r.id)}">Print</button></div></div>
    <div class="rcpt-prev a4prev">${documentFrameHTML(m,docOptions())}</div>${r.sale?`<p class="note"><button type="button" class="link xs" data-billview="${esc(r.sale)}">Back to the bill</button></p>`:""}</div></div>`;
  fitDocFrames($("#modalHost"));
}
/* The bill view's own clicks (app/events/dom-events.js) → true when it was one */
export function billViewClick(t){
  const ret=id=>(D().rets||[]).find(x=>x.id===id);
  const b=t.closest("[data-billpdf]"); if(b){ const s=D().saleById[b.dataset.billpdf]; if(s) downloadDocumentPdf(invoiceModel(s)); return true; }
  const bs=t.closest("[data-billsharepdf]"); if(bs){ const s=D().saleById[bs.dataset.billsharepdf]; if(s) shareDocumentPdf(invoiceModel(s)); return true; }
  const gs=t.closest("[data-gosend]"); if(gs){ const el=$("#sendBox-"+gs.dataset.gosend); if(el){ el.scrollIntoView({block:"center",behavior:"smooth"}); el.classList.add("flash"); setTimeout(()=>el.classList.remove("flash"),1600); } return true; }
  const co=t.closest("[data-cnopen]"); if(co){ openCreditNote(co.dataset.cnopen); return true; }
  const cp=t.closest("[data-cnprint]"); if(cp){ const r=ret(cp.dataset.cnprint); if(r) printDocument(creditNoteModel(r)); return true; }
  const cd=t.closest("[data-cnpdf]"); if(cd){ const r=ret(cd.dataset.cnpdf); if(r) downloadDocumentPdf(creditNoteModel(r)); return true; }
  const cs=t.closest("[data-cnshare]"); if(cs){ const r=ret(cs.dataset.cnshare); if(r) shareDocumentPdf(creditNoteModel(r)); return true; }
  return false;
}

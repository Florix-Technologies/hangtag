// Quotation output: one model feeds preview, browser print, PDF download and sharing. It is deliberately headed
// QUOTATION (never Invoice), and uses the order's saved prices, discounts, GST and customer snapshot. The shop's
// quotation template (Settings → Bills & Documents → Quotations: title, footer, terms, signature, GST shown, number prefix) is light
// settings, not a designer. Send opens a sheet: Email / WhatsApp through the server (use-cases/send-quotation.js, each
// send Queued → Sent / Failed) or the PDF shared from this phone.
import { discountLabel, normalizeDiscount } from '../../../domain/sales/discounts.js';
import { sellerOf } from '../../../domain/invoices/invoice.js';
import { qtyText, unitOf } from '../../../domain/catalog/units.js';
import { QUOTE_CHANNELS, QUOTE_SEND_LABELS } from '../../../domain/orders/orders.js';
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { orderById, orderTotals, setOrderStatus } from '../use-cases/orders.js';
import { loadChannels } from '../../delivery/use-cases/send-invoice.js';
import { onQuoteSendChange, quoteChannelReady, quoteHistory, quoteSendTarget, quoteSendsOf, retryQuoteSend, sendQuotation } from '../use-cases/send-quotation.js';
import { customerRepository } from '../../customers/repositories/customer-repository.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { can } from '../../shop/services/access.js';
import { printDoc } from '../../../shared/ui/print-doc.js';
import { docPdfBytes } from '../../../shared/utils/pdf.js';
import { orderModel, challanModel } from '../../receipts/services/doc-models.js';
import { documentCSS, documentFrameHTML, documentHTML, fitDocFrames } from '../../receipts/components/doc-render.js';
import { docOptions, downloadDocumentPdf, printDocument, shareDocumentPdf } from '../../receipts/components/doc-actions.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { hhmm, fmtDate } from '../../../shared/formatting/dates.js';
import { ICON } from '../../../shared/constants/icons.js';
import { toast } from '../../../shared/components/toast.js';
import { logger } from '../../../shared/logging/logger.js';
import { documentLogo, documentLogoPlace } from '../../receipts/services/logo-display.js';

const dateText=v=>{ if(!v) return "—"; const d=/^\d{4}-\d{2}-\d{2}$/.test(String(v))?new Date(String(v)+"T12:00:00"):new Date(v); return Number.isNaN(+d)?"—":fmtDate(d,{day:"numeric",month:"short",year:"numeric"}); };
const cleanFile=s=>String(s||"quotation").replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80)||"quotation";
const quoteOf=id=>{ const o=orderById(id); return o&&o.kind==="quote"?o:null; };
const allowed=()=>hasCap("uses_quotations")&&can("create_order");
const S=()=>store.settings||{};

export function quotationDocument(o){
  if(!o||o.kind!=="quote") return null;
  const T=orderTotals(o), saved=o.cust&&o.cust.id?customerRepository().get(o.cust.id):null, buyer={...(saved||{}),...(o.cust||{})}, seller=sellerOf(store.profile||{});
  const set=S(), heading=String(set.quoteTitle||"").trim()||"QUOTATION";
  return { heading, number:o.no||"Draft", date:dateText(o.t), validUntil:dateText(o.validUntil), seller, buyer,
    logo:documentLogo(), logoAlign:documentLogoPlace("a4"), footer:set.quoteFooter||set.footer||"", signature:set.quoteSignature||"", showGst:set.quoteGst!==false&&T.mode!=="none",
    notes:o.notes||"", terms:o.terms||"", gstMode:T.mode, inclusive:T.incl,
    items:(o.items||[]).map((l,i)=>{ const x=T.lines[i]||{}, d=normalizeDiscount(l.disc); return { name:l.name||"",variant:l.vl||"",qty:qtyText(l.q,l.u),unit:unitOf(l.u).label,
      price:l.price,discount:d?discountLabel(d):"—",taxable:x.taxable||0,gstRate:x.rate||0,gst:x.tax||0,total:x.total||0 }; }), totals:T };
}

/* The quotation in the shop's document template (receipts/components/doc-render.js; headed with its quotation title) */
export function quotationHTML(o){ const m=o&&o.kind==="quote"?orderModel(o):null; return m?documentHTML(m,docOptions()):""; }
export const QUOTATION_CSS=documentCSS();
const pdfFile=o=>{ const m=orderModel(o); return {name:cleanFile(o.no||"quotation")+".pdf",bytes:docPdfBytes(m,docOptions())}; };

export function openQuotationPreview(id){
  if(!allowed()){ toast("Quotations are switched off or unavailable for this role."); return; } const o=quoteOf(id); if(!o){ toast("That quotation wasn't found."); return; }
  store.quoteDoc=id; $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet qprevsheet" role="dialog" aria-modal="true" aria-label="Preview quotation ${esc(o.no||"")}"><div class="sh-head"><div class="sh-t"><h3>Quotation preview</h3><p>${esc(o.no||"")}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div><div class="qpreview">${documentFrameHTML(orderModel(o),docOptions())}</div><div class="sh-foot"><div class="sh-acts"><button class="btn sm" data-qdoc="print" data-id="${esc(id)}">Print</button><button class="btn sm" data-qdoc="download" data-id="${esc(id)}">Download PDF</button><button class="btn sm primary" data-qdoc="send" data-id="${esc(id)}">Send</button></div></div></div></div>`; fitPreview();
}
/* after the preview sheet is drawn: the frame fits its width */
const fitPreview=()=>fitDocFrames($("#modalHost"));
export function printQuotation(id){ const o=quoteOf(id); if(!o||!allowed()){ toast("That quotation isn't available."); return; } printDoc(`Quotation ${o.no||""}`,QUOTATION_CSS,quotationHTML(o)); }
export async function downloadQuotation(id){ const o=quoteOf(id); if(!o||!allowed()){ toast("That quotation isn't available."); return false; } const f=pdfFile(o); return use("files").saveFile(f.name,f.bytes,"application/pdf"); }
/* The PDF from this phone: the phone's share sheet (WhatsApp, email apps…), else downloaded with an email draft */
export async function shareQuotationPdf(id){
  const o=quoteOf(id); if(!o||!allowed()){ toast("That quotation isn't available."); return; } const f=pdfFile(o), file=typeof File!=="undefined"?new File([f.bytes],f.name,{type:"application/pdf"}):null;
  try{
    if(file&&navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]}))){ await navigator.share({title:`Quotation ${o.no}`,text:`Quotation ${o.no} from ${(store.profile||{}).shop_name||"our shop"}`,files:[file]}); if(o.status==="draft") setOrderStatus(o.id,"sent"); toast("Quotation shared."); return; }
    await use("files").saveFile(f.name,f.bytes,"application/pdf");
    const saved=o.cust&&o.cust.id?customerRepository().get(o.cust.id):null, email=(saved&&saved.email)||(o.cust&&o.cust.email)||"";
    if(email){ const sub=encodeURIComponent(`Quotation ${o.no} from ${(store.profile||{}).shop_name||"our shop"}`),body=encodeURIComponent(`Hello ${o.cust&&o.cust.name||""},\n\nPlease find quotation ${o.no} for ${inr(orderTotals(o).total)}. The PDF has been downloaded; attach it to this message before sending.\n\nThank you.`); location.href=`mailto:${encodeURIComponent(email)}?subject=${sub}&body=${body}`; toast("The PDF was downloaded and an email draft opened. Attach the PDF, then send it."); }
    else toast("Quotation PDF downloaded. Share it with the customer from your files.");
  }catch(e){ if(e&&e.name==="AbortError") return; logger.warn("Quotation share failed:",e); toast("Couldn't share the quotation. Try Download PDF."); }
}

/* ---------- Send: email / WhatsApp through the server, or the PDF from this phone ---------- */
const WAIT={offline:"waiting for the internet",upload:"waiting for the quotation to upload",retry:"will try again"};
function jobHTML(j){
  const st=QUOTE_SEND_LABELS[j.status]||j.status, when=hhmm(j.sentAt||j.failedAt||j.t);
  const why=j.status==="queued"&&j.wait?` · ${WAIT[j.wait]||""}`:"";
  return `<li class="qs-job st-${esc(j.status)}" data-qsjob="${esc(j.id)}"><span class="qs-ch">${esc(QUOTE_CHANNELS[j.channel]||j.channel)}</span><span class="qs-to">${esc(j.to||"")}</span>
    <span class="qs-st"><b>${esc(st)}</b>${esc(why)} · ${esc(when)}</span>${j.status==="failed"&&j.error?`<span class="qs-err">${esc(j.error)}</span>`:""}${j.status==="failed"&&!j.unavailable?`<button type="button" class="link xs" data-qsretry="${esc(j.id)}">Try again</button>`:""}</li>`;
}
function sendSheetHTML(o, cloudRows){
  const mine=quoteSendsOf(o.id), ids=new Set(mine.map(j=>j.requestId));
  const others=(cloudRows||[]).filter(r=>!r.requestId||!ids.has(r.requestId));
  const chan=ch=>{ const t=quoteSendTarget(o,ch), ready=quoteChannelReady(ch), why=t.error||(ready===false?`Not set up on the server yet.`:"");
    return `<button type="button" class="btn${why?"":" primary"}" data-qsend="${ch}" data-id="${esc(o.id)}"${why?' aria-disabled="true"':""}><b>${ch==="email"?"Email":"WhatsApp"}</b><small>${esc(why||t.to)}</small></button>`; };
  return `<div class="scrim" data-modal-scrim><div class="sheet qsendsheet" id="quoteSendSheet" data-qsheet="${esc(o.id)}" role="dialog" aria-modal="true" aria-labelledby="qsT"><div class="sh-head"><div class="sh-t"><h3 id="qsT">Send quotation ${esc(o.no||"")}</h3><p>To ${esc(o.cust&&o.cust.name||"the customer")} · ${inr(orderTotals(o).total)}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="qs-chans">${chan("email")}${chan("whatsapp")}<button type="button" class="btn" data-qdoc="share" data-id="${esc(o.id)}"><b>Share PDF</b><small>From this phone</small></button></div>
    <p class="note">Email and WhatsApp go from the shop's sending service to the customer as saved in Customers. A send waits here (Queued) while you're offline.</p>
    ${mine.length||others.length?`<h4 class="custh">Sent</h4><ul class="qs-jobs">${mine.map(jobHTML).join("")}${others.map(r=>`<li class="qs-job st-${esc(r.status)}"><span class="qs-ch">${esc(QUOTE_CHANNELS[r.channel]||r.channel)}</span><span class="qs-to">${esc(r.to||"")}</span><span class="qs-st"><b>${esc(QUOTE_SEND_LABELS[r.status==="pending"?"sending":r.status]||r.status)}</b> · ${esc(hhmm(r.t))}</span>${r.status==="failed"&&r.error?`<span class="qs-err">${esc(r.error)}</span>`:""}</li>`).join("")}</ul>`:""}
  </div></div>`;
}
let unsub=null, sheetRows=[];
export async function openQuotationSend(id){
  if(!allowed()){ toast("Quotations are switched off or unavailable for this role."); return; }
  const o=quoteOf(id); if(!o){ toast("That quotation wasn't found."); return; }
  if(o.status==="cancelled"){ toast("A cancelled quotation can't be sent."); return; }
  store.quoteDoc=id; sheetRows=[];
  $("#modalHost").innerHTML=sendSheetHTML(o,sheetRows);
  if(unsub) unsub();
  unsub=onQuoteSendChange(oid=>{ if(oid===id) renderQuotationSend(); });
  await loadChannels(); sheetRows=await quoteHistory(id); renderQuotationSend();
}
export function renderQuotationSend(){
  const host=$("#quoteSendSheet"), o=host&&quoteOf(host.dataset.qsheet); if(!o){ if(unsub){ unsub(); unsub=null; } return; }
  $("#modalHost").innerHTML=sendSheetHTML(o,sheetRows);
}
function sendClick(t){
  const b=t.closest("[data-qsend]"); if(b){ const r=sendQuotation(b.dataset.id,b.dataset.qsend); if(r.error) toast(r.error); else toast(r.job.status==="queued"&&store.sbStatus!=="connected"?"Queued: it goes when you're back online.":"Sending…"); renderQuotationSend(); return true; }
  const rt=t.closest("[data-qsretry]"); if(rt){ const r=retryQuoteSend(rt.dataset.qsretry); if(r.error) toast(r.error); renderQuotationSend(); return true; }
  return false;
}
export function quotationDocumentClick(t){
  if(t.closest&&sendClick(t)) return true;
  const a=t.closest&&t.closest("[data-qdoc]"); if(!a) return false; const id=a.dataset.id||(store.quoteDoc||"");
  if(a.dataset.qdoc==="preview") openQuotationPreview(id); else if(a.dataset.qdoc==="print") printQuotation(id); else if(a.dataset.qdoc==="download") downloadQuotation(id);
  else if(a.dataset.qdoc==="send") openQuotationSend(id); else if(a.dataset.qdoc==="share") shareQuotationPdf(id);
  return true;
}

/* ---------- any order's documents: a sales order (print, PDF, share) and its delivery challan ---------- */
export function orderDocClick(t){
  const a=t.closest&&t.closest("[data-odoc]"); if(!a) return false;
  const o=orderById(a.dataset.id); if(!o){ toast("That order wasn't found."); return true; }
  const act=a.dataset.odoc, challan=act.startsWith("challan"), m=challan?challanModel(o):orderModel(o);
  if(!m){ toast("That document isn't available for this order."); return true; }
  if(act==="print"||act==="challan") printDocument(m);
  else if(act==="pdf"||act==="challanpdf") downloadDocumentPdf(m);
  else if(act==="share") shareDocumentPdf(m,`${m.title} ${o.no||""} from ${(store.profile||{}).shop_name||"our shop"}`);
  return true;
}

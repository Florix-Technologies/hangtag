// Cash book and bank book: a card for each on Reports (for the chosen period), and the full list of entries.
// Every entry names the bill it came from; cancelled bills' entries stay listed, marked, and leave the balances.
import { PAY_LABELS } from '../../../domain/sales/payments.js';
import { bankBookFor, cashBookFor } from '../services/books-data.js';
import { periodRange } from '../../reports/services/report-data.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { inrx } from '../../../shared/formatting/money.js';

const kv=(l,v,cls)=>`<div${cls?` class="${cls}"`:""}><span>${l}</span><b>${v}</b></div>`;
const count=(n,c)=>`${n} entr${n===1?"y":"ies"}${c?` · ${c} cancelled`:""}`;

export function cashCardHTML(R){
  const B=cashBookFor(R.from,R.to);
  return `<div class="bookkpis">${kv("Opening",inrx(B.opening))}${kv("Cash sales",inrx(B.cashSales))}${kv("Cash refunds","−"+inrx(B.refunds))}${kv("Cash in hand",inrx(B.closing),"hl")}</div>
    <p class="note">${count(B.entries.length,B.cancelled)} · received ${inrx(B.received)}, change given ${inrx(B.changeGiven)}</p><button class="btn xs" data-book="cash">Open cash book</button>`;
}
export function bankCardHTML(R){
  const B=bankBookFor(R.from,R.to);
  return `<div class="bookkpis">${kv("UPI",inrx(B.upiIn))}${kv("Card",inrx(B.cardIn))}${kv("Refunds","−"+inrx(B.refunds))}${kv("Net to bank",inrx(B.net),"hl")}</div>
    <p class="note">${count(B.entries.length,B.cancelled)}</p><button class="btn xs" data-book="bank">Open bank book</button>`;
}
/* kind: "cash" | "bank" — the entries for the period chosen on Reports */
export function openBook(kind){
  const R=periodRange(), multi=R.from!==R.to, cash=kind==="cash", B=cash?cashBookFor(R.from,R.to):bankBookFor(R.from,R.to);
  const when=t=>(multi?dayLab(dayKey(t))+" · ":"")+hhmm(t);
  const row=e=>{
    const off=e.status!=="posted";
    const what=cash?(e.type==="cash_refund"?"Cash refund":"Cash sale")+(e.type==="cash_sale"&&e.change?` · received ${inrx(e.received)}, change ${inrx(e.change)}`:"")
      :`${PAY_LABELS[e.method]||esc(e.method)} ${e.type==="refund"?"refund":"received"}${e.ref?" · ref "+esc(e.ref):""}`;
    return `<button class="bkrow${off?" off":""}" data-billview="${esc(e.saleId)}" data-entry="${esc(e.id)}"><span class="bk-w"><b>${esc(e.billNo||"Bill")}</b><small>${esc(when(e.t))} · ${what}${off?` · <span class="btag">Cancelled</span>`:""}</small></span>`+
      `<span class="bk-a ${e.in?"in":"out"}">${e.in?"+"+inrx(e.in):"−"+inrx(e.out)}</span>${cash?`<span class="bk-b">${inrx(e.balance)}</span>`:""}</button>`;
  };
  const sum=cash?`<div class="bookkpis">${kv("Opening",inrx(B.opening))}${kv("Cash sales",inrx(B.cashSales))}${kv("Cash refunds","−"+inrx(B.refunds))}${kv("Closing",inrx(B.closing),"hl")}</div>
      <p class="note">Cash received ${inrx(B.received)} · change given ${inrx(B.changeGiven)}. Cash sales count what stays in the drawer.</p>`
    :`<div class="bookkpis">${kv("UPI received",inrx(B.upiIn))}${kv("Card received",inrx(B.cardIn))}${kv("Refunds","−"+inrx(B.refunds))}${kv("Net",inrx(B.net),"hl")}</div>`;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet booksheet" id="bookSheet" data-bookkind="${kind}" role="dialog" aria-modal="true" aria-labelledby="bookT">
    <div class="sh-head"><div class="sh-t"><h3 id="bookT">${cash?"Cash book":"Bank book"}</h3><p>${esc(R.label)}${cash?"":" · UPI and card"}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    ${sum}
    <div class="bklist">${cash?`<div class="bkline"><span>Opening balance</span><b>${inrx(B.opening)}</b></div>`:""}${B.entries.length?B.entries.map(row).join(""):`<p class="muted">No ${cash?"cash":"UPI or card"} entries in this period.</p>`}${cash?`<div class="bkline"><span>Closing balance</span><b>${inrx(B.closing)}</b></div>`:""}</div>
  </div></div>`;
}

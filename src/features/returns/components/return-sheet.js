// Return / exchange sheet: choose what comes back (and whether it can be sold again), what the customer takes instead,
// and how money changes hands. Saving goes through the RecordReturn use case.
import { canRefundThroughProvider, refundThroughProvider } from '../use-cases/provider-refund.js';
import { queueAutoDelivery } from '../../delivery/use-cases/auto-delivery.js';
import { lineLabel } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { billTotals } from '../../sales/services/totals.js';
import { PAY_LABELS, paymentsOf } from '../../../domain/sales/payments.js';
import { D } from '../../inventory/services/ledger.js';
import { exAvail, exchangeCustomer, exchangeDiscount, retQuote, returnable, returnedSerials, unitValue } from '../services/return-rules.js';
import { exchangeSettlement } from '../../../domain/returns/return-value.js';
import { recordReturn } from '../use-cases/record-return.js';
import { closeSheets } from '../../sales/components/bill-panel.js';
import { showPaid } from '../../sales/components/payment-done.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { renderAll } from '../../../shared/ui/render.js';
import { decimalsOf, fmtQty, qtyText, roundQty, subQty, unitOf } from '../../../domain/catalog/units.js';
import { can, refuse } from '../../shop/services/access.js';
import { billDueRoom } from '../../customers/services/customer-account.js';

export const RETURN_REASONS=["Didn't fit","Wrong size","Didn't like it","Damaged or faulty","Other"];
export function openReturn(sid){
  if(refuse("perform_return","take returns"))return;
  const s=D().saleById[sid]; if(!s||s.void) return;
  store.retState={sid, q:{}, sn:{}, nfr:{}, mode:"return", pay:(paymentsOf(s)[0]||{method:billDueRoom(s.id)>0&&can("collect_credit")?"due":"cash"}).method, reason:RETURN_REASONS[0], note:"", newItems:[], collect:"cash", keepDisc:true};
  closeModal(); renderReturnSheet();
}
export function renderReturnSheet(){
  const R=store.retState, s=D().saleById[R&&R.sid]; if(!s){closeSheets();return}
  document.body.style.overflow="hidden";
  if(!R.nfr) R.nfr={};
  if(!R.sn) R.sn={};
  const ex=R.mode==="exchange", Q=retQuote(), val=Q.error?0:Q.value;
  const lines=s.items.map((i,k)=>{const ln=i.ln!=null?i.ln:k,max=returnable(s,i,k),q=R.q[ln]||0;
    // a line sold by weight or length comes back in parts: typed (0.75 of 2.5 kg); pieces step by one
    const dp=decimalsOf(i.u), gone=subQty(i.q,max);
    // a line sold by serial number: the exact pieces coming back are ticked
    const sns=Array.isArray(i.sn)&&i.sn.length?i.sn.filter(x=>!returnedSerials(s,ln).has(x)):null;
    return `<div class="rt-line${max?"":" done"}"><div><b>${esc(i.n)}</b><span>${esc(lineLabel(i)||"")}${lineLabel(i)?" · ":""}bought ${esc(qtyText(i.q,i.u))}${gone?" · "+esc(qtyText(gone,i.u))+" already returned":""} · ${inrx(unitValue(s,i))} ${i.u&&i.u!=="pcs"?"per "+esc(unitOf(i.u).sym):"each"}</span>
      ${q?`<label class="chk rt-nfr"><input type="checkbox" data-rtnfr="${ln}"${R.nfr[ln]?" checked":""}> Not for resale (damaged) — don't put back on the shelf</label>`:""}</div>
      ${!max?`<span class="note">Nothing left to return</span>`:sns?`<span class="rt-sns" role="group" aria-label="Serial numbers of ${esc(i.n)} coming back">${sns.map(x=>`<label class="chk"><input type="checkbox" data-rtsn="${ln}|${esc(x)}"${(R.sn[ln]||[]).includes(x)?" checked":""}> ${esc(x)}</label>`).join("")}</span>`:dp?`<span class="step unitq"><input type="number" inputmode="decimal" min="0" max="${esc(fmtQty(max))}" step="any" data-rtq="${ln}" value="${q?esc(fmtQty(q)):""}" placeholder="0" aria-label="Quantity of ${esc(i.n)} coming back"><span class="qu">${esc(unitOf(i.u).sym)}</span></span>`
        :`<span class="step"><button data-rtm="${ln}" aria-label="One less"${q?"":" disabled"}>−</button><b>${q}</b><button data-rtp="${ln}" aria-label="One more"${q<max?"":" disabled"}>+</button></span>`}</div>`}).join("");
  const dsc=exchangeDiscount(s), nT=billTotals(R.newItems,ex&&R.keepDisc!==false?dsc:null,exchangeCustomer(s)), X=exchangeSettlement(val,nT.total), diff=X.collect||-X.refund;
  const row=(a,b)=>`<div class="row"><span>${a}</span><span class="tnum">${b}</span></div>`;
  const back=val?row("Coming back",inrx(val))+(Q.tax?row(`of which GST reversed`,inrx(Q.tax)):"")+(Q.roundOff?row("Round off (whole bill)",inrx(Q.roundOff)):"")+(ex&&X.roundOff&&R.newItems.length?row("Round off",inrx(X.roundOff)):""):"";
  let exHTML="";
  if(ex){
    exHTML=`<div class="setsec"><h4>New items</h4>${R.newItems.length?R.newItems.map((c,i)=>`<div class="rt-line"><div><b>${esc(c.name)}</b><span>${esc(lineLabel(c))} · ${inr(c.price)} each${Array.isArray(c.sn)&&c.sn.length?" · "+esc(c.sn.join(", ")):""}</span></div><span class="step"><button data-exm="${i}" aria-label="One less">−</button><b>${c.q}</b><button data-exp="${i}" aria-label="One more"${exAvail(c.v)>0?"":" disabled"}>+</button></span></div>`).join(""):`<p class="muted">Add what the customer is taking instead.</p>`}
      ${dsc?`<label class="chk" style="margin-top:8px"><input type="checkbox" data-rtkeep${R.keepDisc!==false?" checked":""}> Give the original bill's ${esc(String(dsc.value))}% discount on the new items</label>`:""}
      <div class="setactions" style="margin-top:8px"><button class="btn sm" data-act="exadd">+ Add items</button></div></div>
      <div class="rt-sum">${back}${row("New items",inrx(nT.total))}
      <div class="row tot"><span>${diff>0?"Customer pays":diff<0?"Refund to customer":"Even exchange"}</span><span class="grand">${diff?inrx(Math.abs(diff)):"₹0"}</span></div></div>`;
  }
  // a bill left partly on the customer's account can be refunded to it ("On account": takes off what they owe)
  const room=billDueRoom(s.id), acct=key=>key==="pay"&&room>0&&can("collect_credit")?["due"]:[];
  const payRow=(label,key)=>`<div class="rt-pay"><span>${label}</span><div class="seg">${["cash","upi","card",...acct(key)].map(k=>`<button type="button" data-rtpay="${key}:${k}" aria-pressed="${R[key]===k}">${PAY_LABELS[k]}</button>`).join("")}</div></div>`+
    (key==="pay"&&R.pay==="due"?`<p class="note">Takes the refund off what ${esc(s.cust&&s.cust.name||"the customer")} owes (at most ${inrx(room)} on this bill). No money changes hands.</p>`:"");
  const label=ex?(diff>0?"Collect "+inrx(diff)+" and exchange":diff<0?"Refund "+inrx(-diff)+" and exchange":"Complete exchange"):"Refund "+inrx(val);
  $("#sheetHost").innerHTML=`<div class="scrim" data-scrim><div class="sheet retsheet" role="dialog" aria-modal="true" aria-label="Return or exchange">
    <div class="sh-head"><div class="sh-t"><h3>${ex?"Exchange":"Return"} · bill ${esc(s.no)}</h3><p>${esc(dtLong(s.t))}${s.cust?" · "+esc(s.cust.name):" · walk-in"}</p></div><button class="iconbtn" data-act="closesheet" aria-label="Close">${ICON.x}</button></div>
    <div class="seg rt-mode" role="group" aria-label="Return or exchange"><button data-rtmode="return" aria-pressed="${!ex}">Return for refund</button><button data-rtmode="exchange" aria-pressed="${ex}">Exchange</button></div>
    <div class="setsec" style="margin-top:12px;border-top:0;padding-top:0"><h4>Items coming back</h4>${lines}</div>
    ${exHTML}
    ${!ex&&val?`<div class="rt-sum">${Q.tax||Q.roundOff?back:""}<div class="row tot"><span>Refund</span><span class="grand">${inrx(val)}</span></div></div>${payRow("Refund by","pay")}${provRefundHTML(R,s)}`:""}
    ${ex&&diff>0?payRow("Customer pays by","collect")+collectRefHTML(R):""}${ex&&diff<0?payRow("Refund by","pay")+provRefundHTML(R,s):""}
    <label class="f" style="margin-top:12px">Reason<select id="rtReason">${RETURN_REASONS.map(r=>`<option${r===R.reason?" selected":""}>${r}</option>`).join("")}</select></label>
    <p id="rtErr" class="autherr" hidden></p>
    <div class="sh-foot"><span class="note">A credit note is made for the return. Stock goes back on the shelf unless marked not for resale.</span><div class="sh-acts"><button class="btn sm" data-act="closesheet">Cancel</button><button class="btn sm primary" data-act="rtsave"${val?"":" disabled"}>${label}</button></div></div>
  </div></div>`;
}
/* A UPI / card refund on a bill the provider verified can go back through the provider (on by default) */
function provRefundHTML(R,s){
  if(!canRefundThroughProvider(s,R.pay)) return "";
  return `<label class="chk rt-prov"><input type="checkbox" data-rtprov${R.provRefund!==false?" checked":""}> Send the refund back to the customer's ${PAY_LABELS[R.pay]} through the payment provider</label>`;
}
/* UPI or card collected on an exchange: the transaction / card machine reference (never a card number) */
function collectRefHTML(R){
  if(R.collect==="cash") return "";
  return `<div class="pgrid2"><label class="f"><span class="lab">${R.collect==="upi"?"UPI reference (UTR)":"Card machine reference"}</span><input id="rtRef" value="${esc(R.collectRef||"")}" maxlength="40" autocomplete="off"></label>`+
    (R.collect==="card"?`<label class="f"><span class="lab">Last 4 digits <small>(optional)</small></span><input id="rtLast4" value="${esc(R.collectLast4||"")}" inputmode="numeric" maxlength="4" autocomplete="off"></label>`:"")+`</div>`;
}
export function saveReturn(){
  const R=store.retState; if(!R) return;
  const reason=($("#rtReason")||{}).value||R.reason;
  const r=recordReturn({sid:R.sid,picks:R.q,serials:R.sn,mode:R.mode,pay:R.pay,collect:R.collect==="cash"?"cash":{method:R.collect,ref:R.collectRef||"",last4:R.collectLast4||""},reason,notForResale:R.nfr,newItems:R.newItems,keepDiscount:R.keepDisc!==false});
  if(r.error){const err=$("#rtErr");if(err){err.textContent=r.error;err.hidden=false}return}
  const s=D().saleById[R.sid], viaProvider=r.refund>0&&R.provRefund!==false&&canRefundThroughProvider(s,r.ret.pay);
  store.retState=null; closeSheets(); renderAll();
  if(viaProvider) refundThroughProvider(r.ret).then(x=>toast(x.error||`Refund of ${inrx(r.refund)} sent back through the payment provider (${x.refundId}).`));
  // the exchange's new bill goes to the customer by the same rules as any bill
  if(r.sale){ queueAutoDelivery(r.sale); showPaid(r.sale); }
  else toast(`Return saved · credit note ${r.ret.no} · refund ${inrx(r.refund)} by ${PAY_LABELS[r.ret.pay]}. ${r.ret.items.every(i=>i.restock)?"Stock is back on the shelf.":"Items not for resale stay off the shelf."}`);
}
/* A serial of bill line ln ticked (on: coming back) or not: the quantity coming back is the number ticked */
export function setReturnSerial(ln,sn,on){
  const R=store.retState; if(!R) return;
  const list=(R.sn[ln]||[]).filter(x=>x!==sn); if(on) list.push(sn);
  R.sn[ln]=list; R.q[ln]=list.length; renderReturnSheet();
}
/* A typed quantity coming back on bill line ln (a line sold by weight or length): rounded to its unit's decimals, never more
   than is left to return */
export function setReturnQty(ln,raw){
  const R=store.retState, s=R&&D().saleById[R.sid]; if(!s) return;
  const k=s.items.findIndex((x,j)=>(x.ln!=null?x.ln:j)===+ln), i=s.items[k]; if(!i) return;
  const max=returnable(s,i,k), q=Math.max(0,roundQty(+String(raw).replace(",",".")||0,decimalsOf(i.u)));
  if(q>max) toast(`Only ${qtyText(max,i.u)} can still come back.`);
  R.q[ln]=Math.min(q,max); renderReturnSheet();
}

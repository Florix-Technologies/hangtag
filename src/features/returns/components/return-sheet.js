// Return / exchange sheet.
import { lineLabel } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { billTotals } from '../../sales/services/totals.js';
import { PAY_LABELS, paymentsOf } from '../../../domain/sales/payments.js';
import { D } from '../../inventory/services/ledger.js';
import { exAvail, retValue, returnable, unitValue } from '../services/return-rules.js';
import { closeSheets } from '../../sales/components/bill-panel.js';
import { showPaid } from '../../sales/components/payment-done.js';
import { newSaleRecord, recordSale } from '../../sales/use-cases/checkout.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';
import { saveReturns } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { uid } from '../../../shared/utils/ids.js';

/* The original bill's customer, for the new bill of an exchange */
const exCust=s=>s.cust?{id:s.cust.id,name:s.cust.name,phone:s.cust.phone}:null;
export function openReturn(sid){
  const s=D().saleById[sid]; if(!s||s.void) return;
  store.retState={sid, q:{}, mode:"return", pay:(paymentsOf(s)[0]||{method:"cash"}).method, reason:"Didn't fit", note:"", newItems:[], collect:"cash"};
  closeModal(); renderReturnSheet();
}
export function renderReturnSheet(){
  const s=D().saleById[store.retState&&store.retState.sid]; if(!s){closeSheets();return}
  document.body.style.overflow="hidden";
  const ex=store.retState.mode==="exchange", val=retValue();
  const lines=s.items.map((i,k)=>{const ln=i.ln!=null?i.ln:k,max=returnable(s,i,k),q=store.retState.q[ln]||0;
    return `<div class="rt-line${max?"":" done"}"><div><b>${esc(i.n)}</b><span>${esc(lineLabel(i)||"")}${lineLabel(i)?" · ":""}bought ${i.q}${i.q-max?" · "+(i.q-max)+" already returned":""} · ${inr(unitValue(s,i))} each</span></div>
      ${max?`<span class="step"><button data-rtm="${ln}" aria-label="One less"${q?"":" disabled"}>−</button><b>${q}</b><button data-rtp="${ln}" aria-label="One more"${q<max?"":" disabled"}>+</button></span>`:`<span class="note">Nothing left to return</span>`}</div>`}).join("");
  const nT=billTotals(store.retState.newItems,null,exCust(s)), diff=nT.total-val;
  let exHTML="";
  if(ex){
    exHTML=`<div class="setsec"><h4>New items</h4>${store.retState.newItems.length?store.retState.newItems.map((c,i)=>`<div class="rt-line"><div><b>${esc(c.name)}</b><span>${esc(lineLabel(c))} · ${inr(c.price)} each</span></div><span class="step"><button data-exm="${i}" aria-label="One less">−</button><b>${c.q}</b><button data-exp="${i}" aria-label="One more"${exAvail(c.v)>0?"":" disabled"}>+</button></span></div>`).join(""):`<p class="muted">Add what the customer is taking instead.</p>`}
      <div class="setactions" style="margin-top:8px"><button class="btn sm" data-act="exadd">+ Add items</button></div></div>
      <div class="rt-sum">${[["Returned items",inr(val)],["New items",inr(nT.total)]].map(([a,b])=>`<div class="row"><span>${a}</span><span class="tnum">${b}</span></div>`).join("")}
      <div class="row tot"><span>${diff>0?"Customer pays":diff<0?"Refund to customer":"Even exchange"}</span><span class="grand">${diff?inr(Math.abs(diff)):"₹0"}</span></div></div>`;
  }
  const payRow=(label,key)=>`<div class="rt-pay"><span>${label}</span><div class="seg">${["cash","upi","card"].map(k=>`<button type="button" data-rtpay="${key}:${k}" aria-pressed="${store.retState[key]===k}">${PAY_LABELS[k]}</button>`).join("")}</div></div>`;
  $("#sheetHost").innerHTML=`<div class="scrim" data-scrim><div class="sheet retsheet" role="dialog" aria-modal="true" aria-label="Return or exchange">
    <div class="sh-head"><div class="sh-t"><h3>${ex?"Exchange":"Return"} · bill ${esc(s.no)}</h3><p>${esc(dtLong(s.t))}${s.cust?" · "+esc(s.cust.name):""}</p></div><button class="iconbtn" data-act="closesheet" aria-label="Close">${ICON.x}</button></div>
    <div class="seg rt-mode" role="group" aria-label="Return or exchange"><button data-rtmode="return" aria-pressed="${!ex}">Return for refund</button><button data-rtmode="exchange" aria-pressed="${ex}">Exchange</button></div>
    <div class="setsec" style="margin-top:12px;border-top:0;padding-top:0"><h4>Items coming back</h4>${lines}</div>
    ${exHTML}
    ${!ex&&val?`<div class="rt-sum"><div class="row tot"><span>Refund</span><span class="grand">${inr(val)}</span></div></div>${payRow("Refund by","pay")}`:""}
    ${ex&&diff>0?payRow("Customer pays by","collect"):""}${ex&&diff<0?payRow("Refund by","pay"):""}
    <label class="f" style="margin-top:12px">Reason<select id="rtReason">${["Didn't fit","Wrong size","Didn't like it","Damaged or faulty","Other"].map(r=>`<option${r===store.retState.reason?" selected":""}>${r}</option>`).join("")}</select></label>
    <p id="rtErr" class="autherr" hidden></p>
    <div class="sh-foot"><span class="note">Stock goes back on the shelf for returned items.</span><div class="sh-acts"><button class="btn sm" data-act="closesheet">Cancel</button><button class="btn sm primary" data-act="rtsave"${val?"":" disabled"}>${ex?(diff>0?"Collect "+inr(diff)+" and exchange":diff<0?"Refund "+inr(-diff)+" and exchange":"Complete exchange"):"Refund "+inr(val)}</button></div></div>
  </div></div>`;
}
export function saveReturn(){
  const s=D().saleById[store.retState.sid]; if(!s) return;
  const err=$("#rtErr"), bad=m=>{if(err){err.textContent=m;err.hidden=false}};
  const reason=($("#rtReason")||{}).value||store.retState.reason;
  const items=[];
  for(const [k,i] of s.items.entries()){
    const ln=i.ln!=null?i.ln:k, q=store.retState.q[ln]||0; if(!q) continue;
    if(q>returnable(s,i,k)) return bad(`Only ${returnable(s,i,k)} of ${i.n} can still be returned.`);
    items.push({ln,v:D().resolve(i)||i.v,p:i.p,n:i.n,c:i.c||"",s:i.s||"",vl:lineLabel(i),ov:i.ov||[],sku:i.sku||"",q,price:unitValue(s,i),value:Math.round(q*unitValue(s,i)),cost:i.cost==null?null:i.cost});
  }
  if(!items.length) return bad("Choose at least one item coming back.");
  const val=items.reduce((a,i)=>a+i.value,0), ex=store.retState.mode==="exchange";
  if(ex&&!store.retState.newItems.length) return bad("Add the new items for the exchange, or switch to Return.");
  for(const c of store.retState.newItems){ if(exAvail(c.v)<0) return bad(`Not enough ${c.name} ${lineLabel(c)} in stock.`); }
  const t=Date.now(), exId=ex?"x"+uid():null;
  let newSale=null, refund=val;
  if(ex){
    // the new bill is for the same customer; what comes back is credit against it, the rest is paid or refunded
    const cust=exCust(s), credit=Math.min(val,billTotals(store.retState.newItems,null,cust).total);
    newSale=newSaleRecord(store.retState.newItems,null,store.retState.collect,{kind:"exchange",ex:exId,cust,credit});
    if(newSale.error) return bad(newSale.error);
    refund=Math.max(0,val-newSale.total);
  }
  const ret={id:"r"+uid(),sale:s.id,t,kind:ex?"exchange":"return",ex:exId,refund,pay:store.retState.pay,value:val,note:reason,dev:store.dev,items};
  store.returnsMap[ret.id]=ret; saveReturns();
  enqueue({type:"return",id:ret.id,ret});
  if(newSale){ store.lastSale=newSale; recordSale(newSale); } else { renderSync(); flushSbQueue(); }
  store.retState=null; closeSheets(); renderAll();
  if(newSale) showPaid(newSale);
  else toast(`Return saved · refund ${inr(refund)} by ${PAY_LABELS[ret.pay]}. Stock is back on the shelf.`);
}

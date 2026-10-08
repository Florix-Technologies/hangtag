// Reports page sections.
import { lineLabel, optionSnapshot } from '../../../domain/catalog/options.js';
import { optionBreakdown } from '../../../domain/reports/option-breakdown.js';
import { store } from '../../../shared/state/store.js';
import { vLabel, variantsOf } from '../../../domain/catalog/variants.js';
import { levelOf } from '../../inventory/services/stock-levels.js';
import { payLabel } from '../../../domain/sales/payments.js';
import { eventFilterHTML, gstCardHTML, movementHTML, profitHTML, summaryHTML } from '../components/report-sections.js';
import { eventsCardHTML } from '../../events/components/events-view.js';
import { paymentSummary, profitSummary } from '../../../domain/reports/sales-report.js';
import { bankCardHTML, cashCardHTML } from '../../finance/components/books-view.js';
import { reconcileCardHTML } from '../../finance/components/reconcile-view.js';
import { salesByChannel } from '../../commerce/services/channels.js';
import { D } from '../../inventory/services/ledger.js';
import { productLeft, stockOf } from '../../inventory/services/stock.js';
import { thumb } from '../../products/components/thumb.js';
import { liveProducts, prod, sizeOrder } from '../../products/services/catalog.js';
import { byProduct, delta, kstats, netLines, periodData, periodRange, timeSeries } from '../services/report-data.js';
import { colChart, tableHTML } from '../../../shared/components/charts.js';
import { kpi } from '../../../shared/components/kpi.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { dayKey, dayLong, hhmm } from '../../../shared/formatting/dates.js';
import { inr, inrShort, inrx } from '../../../shared/formatting/money.js';
import { initials } from '../../../shared/utils/text.js';
import { qtyText, roundQty } from '../../../domain/catalog/units.js';
import { returnsByReason } from '../../../domain/returns/return-reasons.js';

export const showTable={time:false,size:false};
/* the option the "Sold by option" card shows (the most-sold one when none is chosen or it sold nothing in the period) */
export const reportOption={name:""};
export function drawTime(TS){
  const host=$("#chTime");if(!host)return;const rows=TS.rows;
  if(!rows.length||rows.every(r=>!r.v)){host.innerHTML=`<p class="muted">No sales in this period.</p>`;return}
  if(showTable.time){host.innerHTML=tableHTML([TS.unit,"Sales","Bills","Pieces"],rows.filter(r=>r.n||r.v).map(r=>[r.label,inr(r.v),r.n,r.p]));return}
  colChart(host,rows.map(r=>({short:r.short,v:r.v,tv:inr(r.v),tl:r.label,tm:r.n+" bill"+(r.n===1?"":"s")+" · "+r.p+" pcs"})),{axis:inrShort,peak:inrShort,labelW:TS.labelW,aria:TS.title});
}
/* Each line's options as the product names them now ({ n, v }); a line whose variant is gone keeps its colour and size */
function lineOptions(l){
  const rec=D().vIdx[l.vid];
  if(rec) return optionSnapshot(rec.p,rec.v);
  return [l.c&&{n:"Colour",v:l.c},l.s&&{n:"Size",v:l.s}].filter(Boolean);
}
/* An option's values in the order the shop's products define them (sizes as sizes run) */
function optionOrder(name,seen){
  const k=String(name).trim().toLowerCase(), order=[];
  liveProducts().forEach(p=>(p.opts||[]).filter(o=>String(o.n||"").trim().toLowerCase()===k).forEach(o=>(o.v||[]).forEach(v=>{if(!order.includes(String(v)))order.push(String(v))})));
  return /^sizes?$/.test(k)?sizeOrder(seen):order;
}
/* The period's pieces by option, and the option shown */
export function optionsSold(lines){
  const OB=optionBreakdown(lines.map(l=>({pid:l.pid,name:l.name,q:l.q,amt:l.amt,opts:lineOptions(l)})),{orderOf:optionOrder});
  const name=OB.names.find(n=>n.toLowerCase()===String(reportOption.name).toLowerCase())||OB.names[0]||"";
  return {OB,name,one:name?OB.of(name):null};
}
/* "Sold by option": a chip for each option the products sold have, the chart (or table) of the one chosen */
export function optionChipsHTML(S){
  return S.OB.names.length>1?`<div class="billfilters optchips" role="group" aria-label="Option">${S.OB.names.map(n=>`<button type="button" class="chipbtn${n===S.name?" on":""}" data-repopt="${esc(n)}" aria-pressed="${n===S.name}">${esc(n)}</button>`).join("")}</div>`:"";
}
export function drawSizes(lines,S=optionsSold(lines)){
  const host=$("#chSize");if(!host)return;
  const one=S.one;
  if(!one||!one.total){host.innerHTML=`<p class="muted">${S.OB.plain>0?"What sold this period has no options (sizes, colours, storage…).":"Nothing sold in this period."}</p>`;return}
  if(showTable.size){host.innerHTML=tableHTML([one.name,"Pieces","Share"],one.values.map(x=>[x.value,x.q,x.share+"%"]));return}
  colChart(host,one.values.map(x=>({short:x.value,v:x.q,tv:x.q+" pcs",tl:one.name+" "+x.value,tm:x.share+"% of pieces sold"})),{axis:v=>String(v),peak:v=>v+" pcs",int:true,labelW:Math.min(60,Math.max(24,...one.values.map(x=>x.value.length*7))),aria:"Pieces sold by "+one.name.toLowerCase()});
}
export function payHTML(live,rets,R){
  // each payment counts under its own method, so a split bill adds to more than one (domain/reports/sales-report.js)
  const PM=paymentSummary(live,rets);
  const segs=[["upi","UPI"],["cash","Cash"],["card","Card"]].map(([k,l])=>({k,l,v:PM.methods[k].net,n:PM.methods[k].bills,rf:PM.methods[k].refunds}));
  const tot=segs.reduce((a,s)=>a+Math.max(0,s.v),0);if(!tot&&!segs.some(s=>s.v))return `<p class="muted">No payments in this period.</p>`;
  const pct=v=>tot?Math.round(Math.max(0,v)/tot*100):0;
  let h=`<div class="stack" role="img" aria-label="${esc(segs.map(s=>s.l+" "+pct(s.v)+"%").join(", "))}">${segs.filter(s=>s.v>0).map(s=>`<span class="seg c-${s.k}" style="flex-grow:${s.v}" tabindex="0" data-tipv="${esc(inr(s.v))}" data-tipl="${esc(s.l+" · "+pct(s.v)+"%")}" data-tipm="${esc(s.n+" bill"+(s.n===1?"":"s"))}"></span>`).join("")}</div>`;
  h+=`<div class="lgd">${segs.map(s=>`<div class="lgr"><span class="sw c-${s.k}"></span><span class="ln">${s.l}<small>${s.n} bill${s.n===1?"":"s"}${s.rf?" · "+inrx(s.rf)+" refunded":""}</small></span><span class="lv">${inrx(s.v)}</span><span class="lp">${pct(s.v)}%</span></div>`).join("")}</div>`;
  if(PM.split.bills)h+=`<p class="note">${PM.split.bills} split-payment bill${PM.split.bills===1?"":"s"} · ${inrx(PM.split.value)}</p>`;
  const cash=segs.find(s=>s.k==="cash").v;
  if(R.from===R.to&&cash>0)h+=`<p class="cashnote">${ICON.cash}<span>Cash that should be in the box: <b>${inrx(cash)}</b></span></p>`;
  return h;
}
export function bestHTML(lines){
  const all=Object.values(byProduct(lines)).filter(r=>r.q>0).sort((a,b)=>b.q-a.q||b.a-a.a),rows=all.slice(0,10);
  if(!rows.length)return `<p class="muted">Nothing sold in this period.</p>`;
  const max=rows[0].q;
  return `<div class="hb">${rows.map(r=>{const p=prod(r.id)||{id:r.id,name:r.n,color:"#8E8A83"},f=max?r.q/max:0;return `<div class="hbr" tabindex="0" data-tipv="${esc(r.q+" pcs · "+inr(r.a))}" data-tipl="${esc(p.name)}"><div class="who">${thumb(p,"xs")}<span class="nmx">${esc(p.name)}</span></div><div class="track"><span class="bar2" style="width:calc((100% - 104px) * ${f.toFixed(4)})"></span><span class="v">${r.q} pcs<small>${inrShort(r.a)}</small></span></div></div>`}).join("")}</div>${all.length>10?`<p class="muted">+${all.length-10} more in Product × size below.</p>`:""}`;
}
export function variantPerfHTML(lines){
  const m={};lines.forEach(l=>{const o=m[l.vid]||(m[l.vid]={pid:l.pid,n:l.name,vl:l.vl,q:0,a:0});o.q=roundQty(o.q+l.q);o.a+=l.amt});
  const rows=Object.values(m).filter(r=>r.q>0).sort((a,b)=>b.q-a.q||b.a-a.a).slice(0,10);
  if(!rows.length)return `<p class="muted">Nothing sold in this period.</p>`;
  return `<div class="vperf">${rows.map((r,i)=>{const p=prod(r.pid)||{id:r.pid,name:r.n,color:"#8E8A83"};return `<div class="vp-row"><span class="vp-i">${i+1}</span>${thumb(p,"xs")}<span class="vp-n"><b>${esc(p.name)}</b>${r.vl?` <span class="szl">${esc(r.vl)}</span>`:""}</span><span class="vp-q">${r.q} sold</span><span class="vp-a">${inr(r.a)}</span></div>`}).join("")}</div>`;
}
/* Product × the option shown: each product that has it, its values as columns, darker = more */
export function optionHeatHTML(S){
  const one=S.one;
  if(!one||!one.products.length)return `<p class="muted">Nothing with options sold in this period.</p>`;
  const vals=one.values.map(x=>x.value);let max=0;one.products.forEach(p=>vals.forEach(v=>{if((p.by[v]||0)>max)max=p.by[v]}));
  const colT={};let all=0,allA=0;
  const body=one.products.map(r=>{const p=prod(r.pid)||{id:r.pid,name:r.name,color:"#8E8A83"};const cells=vals.map(v=>{const q=r.by[v]||0;colT[v]=roundQty((colT[v]||0)+q);return q<=0?`<td class="h0">${q<0?q:"·"}</td>`:`<td class="h${Math.max(1,Math.ceil(q/max*6))}">${q}</td>`}).join("");all=roundQty(all+r.q);allA+=r.amt;
    return `<tr><td class="pn"><span class="who">${thumb(p,"xs")}<span class="nmx">${esc(p.name)}</span></span></td>${cells}<td class="sum">${r.q}</td><td class="am">${inr(r.amt)}</td></tr>`}).join("");
  return `<div class="tw"><table class="hm"><thead><tr><th>Product</th>${vals.map(v=>`<th>${esc(v)}</th>`).join("")}<th>Pieces</th><th style="text-align:right">Amount</th></tr></thead><tbody>${body}</tbody><tfoot><tr><td class="pn">All products</td>${vals.map(v=>`<td>${colT[v]||0}</td>`).join("")}<td class="sum">${all}</td><td class="am">${inr(allA)}</td></tr></tfoot></table></div><div class="hmleg"><span>Fewer</span>${[1,2,3,4,5,6].map(i=>`<i class="h${i}"></i>`).join("")}<span>More pieces · ${esc(one.name.toLowerCase())} only (the other options together)</span></div>`;
}
export function slowHTML(lines,R){
  const sold=byProduct(lines);
  const rows=liveProducts().map(p=>({p,q:(sold[p.id]||{q:0}).q,left:productLeft(p)})).filter(r=>r.q<=0&&r.left>0).sort((a,b)=>b.left-a.left).slice(0,8);
  if(!rows.length)return `<p class="okline">${ICON.ok}Every product in stock sold at least once in this period.</p>`;
  return `<div class="vperf">${rows.map(r=>`<div class="vp-row">${thumb(r.p,"xs")}<span class="vp-n"><b>${esc(r.p.name)}</b></span><span class="vp-q">0 sold</span><span class="vp-a">${r.left} in stock</span></div>`).join("")}</div>`;
}
export function lowStockHTML(){
  const rows=[];liveProducts().forEach(p=>variantsOf(p).forEach(v=>{const n=stockOf(v.id),lv=levelOf(n,p);if(lv!=="ok")rows.push({p,v,n,lv})}));
  rows.sort((a,b)=>a.n-b.n);
  if(!rows.length)return `<p class="okline">${ICON.ok}Nothing is running low.</p>`;
  return `<div class="alerts">${rows.slice(0,10).map(a=>`<button class="al ${a.lv}" data-stockin="${esc(a.p.id)}">${a.lv==="out"?ICON.out:ICON.warn}<b>${esc(a.p.name)}</b>${vLabel(a.v)?`<span class="szl">${esc(vLabel(a.v))}</span>`:""}<span class="st">${a.lv==="out"?"sold out":a.n+" left"}</span></button>`).join("")}${rows.length>10?`<button class="al" data-tab="stock">+${rows.length-10} more on Stock</button>`:""}</div>`;
}
/* After-sales: why things came back in the period (each line's reason), what came back most, and what went back on the
   shelf or stayed off it (domain/returns/return-reasons.js) */
export function returnsHTML(rets){
  const X=returnsByReason(rets); if(!X.count) return "";
  const max=Math.max(1,...X.reasons.map(r=>r.pieces));
  const reasons=X.reasons.map(r=>`<div class="rr-row"><span class="rr-n">${esc(r.reason)}</span><span class="rr-bar"><i style="width:${Math.max(4,Math.round(r.pieces/max*100))}%"></i></span><b class="rr-q">${esc(qtyText(r.pieces))}</b><span class="rr-v">${inr(r.value)}</span></div>`).join("");
  const top=X.products.slice(0,3).map(p=>`<li>${p.id?`<button type="button" class="link xs" data-prodopen="${esc(p.id)}">${esc(p.name)}</button>`:esc(p.name)} — ${esc(qtyText(p.pieces))} back, mostly “${esc(p.top)}”</li>`).join("");
  return `<div class="card span-5" id="returnsCard"><div class="card-h"><h3>Returns</h3><span class="note">${X.count} return${X.count===1?"":"s"} · ${esc(qtyText(X.pieces))} piece${X.pieces===1?"":"s"} · ${inr(X.value)}</span></div>
    <div class="rr">${reasons}</div>${top?`<h4 class="subh">Came back most</h4><ul class="rr-top">${top}</ul>`:""}
    <p class="note">Back on the shelf: ${esc(qtyText(X.shelf.pieces))} (${inr(X.shelf.value)}) · kept off, damaged: ${esc(qtyText(X.off.pieces))} (${inr(X.off.value)})</p></div>`;
}
export function custTopHTML(live,rets){
  const m={};live.forEach(s=>{if(!s.cust||!s.cust.id)return;const o=m[s.cust.id]||(m[s.cust.id]={id:s.cust.id,n:s.cust.name,b:0,a:0});o.b+=(s.kind||"sale")!=="exchange"?1:0;o.a+=s.total});
  rets.forEach(r=>{const s=D().saleById[r.sale];if(s&&s.cust&&m[s.cust.id])m[s.cust.id].a-=r.value||0});
  const rows=Object.values(m).sort((a,b)=>b.a-a.a).slice(0,6);
  if(!rows.length)return `<p class="muted">No bills with a customer in this period. Add a customer on a bill to see them here.</p>`;
  return `<div class="vperf">${rows.map(r=>`<button class="vp-row asbtn" data-custhist="${esc(r.id)}"><span class="avatar sm">${esc(initials((store.customers[r.id]||{}).name||r.n))}</span><span class="vp-n"><b>${esc((store.customers[r.id]||{}).name||r.n)}</b></span><span class="vp-q">${r.b} bill${r.b===1?"":"s"}</span><span class="vp-a">${inr(r.a)}</span></button>`).join("")}</div>`;
}
export function billsHTML(all,R){
  if(!all.length)return `<p class="muted">No bills in this period.</p>`;
  const cap=store.showAllBills?400:25,list=all.slice(0,cap),multi=R.from!==R.to;let h=`<div class="bills">`,cur="";
  list.forEach(s=>{const k=dayKey(s.t);if(multi&&k!==cur){cur=k;h+=`<div class="bday">${esc(dayLong(k))}</div>`}
    const rt=D().retBySale[s.id],tags=(s.kind==="exchange"?`<span class="btag">Exchange</span>`:"")+(rt&&rt.length?`<span class="btag">${rt.some(r=>r.kind==="exchange")?"Exchanged":"Returned"}</span>`:"")+(s.cust?`<span class="btag c">${esc(s.cust.name)}</span>`:"");
    h+=`<div class="bill${s.void?" void":""}"><span class="bt">${esc(hhmm(s.t))}</span><button class="bi asbtn" data-billview="${esc(s.id)}">${s.items.map(i=>`${esc(i.n)}${lineLabel(i)?` <span class="szl">${esc(lineLabel(i))}</span>`:""}${i.q>1||(i.u&&i.u!=="pcs")?" ×"+esc(qtyText(i.q,i.u)):""}`).join(", ")}${tags}</button><span class="ptag c-${esc(s.pay)}">${esc(payLabel(s))}</span><span class="ba">${inr(s.total)}</span><button class="btn xs" data-billview="${esc(s.id)}">Open</button></div>`});
  if(all.length>cap)h+=store.showAllBills?`<p class="muted">Showing the latest ${cap} of ${all.length} bills — download the CSV for all of them.</p>`:`<div class="row c" style="padding-top:12px"><button class="btn sm" data-act="allbills">Show all ${all.length} bills</button></div>`;
  return h+`</div>`;
}
/* Sales by channel (commerce/services/channels.js): the counter, the online store, sales orders, dine-in, events — shown
   when the period's bills came through more than one */
function channelCardHTML(R){
  const C=salesByChannel(R.from,R.to); if(C.length<2) return "";
  const total=C.reduce((a,c)=>a+Math.max(0,c.sales),0)||1;
  return `<div class="card span-12" id="channelCard"><div class="card-h"><h3>Sales by channel</h3><span class="note">One stock and one set of books across every way you sell</span></div>
    <div class="chanlist">${C.map(c=>`<div class="chanrow" data-channel="${esc(c.key)}"><span class="chan-n">${esc(c.label)}</span><span class="chan-bar" aria-hidden="true"><i style="width:${Math.max(2,Math.round(Math.max(0,c.sales)/total*100))}%"></i></span><b>${inr(c.sales)}</b><small>${c.bills} bill${c.bills===1?"":"s"} · ${Math.round(Math.max(0,c.sales)/total*100)}%</small></div>`).join("")}</div></div>`;
}
export function renderReport(){
  const R=periodRange();
  $$("[data-period]").forEach(b=>b.setAttribute("aria-pressed",String(store.prefs.period===b.dataset.period)));
  const rc=$("#repCustom");if(rc){rc.hidden=store.prefs.period!=="custom";const f=$("#repFrom"),t=$("#repTo"),mx=dayKey(Date.now());f.max=t.max=mx;if(document.activeElement!==f)f.value=R.from;if(document.activeElement!==t)t.value=R.to}
  $("#repSub").textContent=R.label;
  const {all,live,rets}=periodData(R.from,R.to);
  const host=$("#repBody"), evCard=`<div class="card span-12"><div class="card-h"><h3>Events</h3><span class="note">Pop-ups, fairs and exhibitions: their bills are tagged and reported apart</span></div>${eventsCardHTML()}</div>`;
  if(!all.length&&!rets.length){host.innerHTML=`${eventFilterHTML()}<div class="empty"><b>No sales ${store.prefs.period==="today"?"yet today":"in this period"}</b><p>Bills you ring up on the Sell tab show up here straight away.</p></div><div class="dash">${evCard}</div>`;return}
  const lines=netLines(live,rets), OS=optionsSold(lines);
  const K=kstats(live,rets),PD=R.prev?periodData(R.prev.from,R.prev.to):null,P=PD?kstats(PD.live,PD.rets):null,TS=timeSeries(live,rets,R);
  const PS=profitSummary(lines);
  let h=eventFilterHTML()+`<div class="kpis five"><div class="kpi hero"><div class="lab">Total sales</div><div class="val">${inr(K.rev)}</div><div class="kps">${delta(K.rev,P&&P.rev,R.vs)}${K.retVal?` <span class="delta flat">after ${inr(K.retVal)} returns</span>`:""}</div></div>`;
  h+=kpi("Bills",String(K.bills),delta(K.bills,P&&P.bills,R.vs))+kpi("Pieces sold",String(K.pcs),K.pcsRet?`${K.pcsRet} returned · `+delta(K.pcs,P&&P.pcs,R.vs):delta(K.pcs,P&&P.pcs,R.vs))+kpi("Average bill",inr(K.avg),delta(K.avg,P&&P.avg,R.vs))+kpi("Discounts given",inr(K.dsc),K.dsc?Math.round(K.dsc/(K.gross+K.dsc)*100)+"% off full price":"none")+`</div>`;
  h+=`<div class="dash">
    <div class="card span-8"><div class="card-h"><h3>${TS.title}</h3><button class="btn xs" data-table="time" aria-pressed="${showTable.time}">${showTable.time?"Show chart":"Show table"}</button></div><div id="chTime" class="chart"></div></div>
    <div class="card span-4"><div class="card-h"><h3>How customers paid</h3></div>${payHTML(live,rets,R)}</div>
    ${channelCardHTML(R)}
    <div class="card span-6" id="cashBook"><div class="card-h"><h3>Cash book</h3><span class="note">Cash in and out, with the balance</span></div>${cashCardHTML(R)}</div>
    <div class="card span-6" id="bankBook"><div class="card-h"><h3>Bank book</h3><span class="note">UPI and card payments</span></div>${bankCardHTML(R)}</div>
    <div class="card span-12" id="reconcileCard"><div class="card-h"><h3>Reconciliation</h3><span class="note">UPI to verify and money received that isn't on a bill</span></div>${reconcileCardHTML(R)}</div>
    <div class="card span-7"><div class="card-h"><div><h3>Summary</h3><span class="note">What each figure means is next to it</span></div><button class="btn xs" data-act="sumcsv">Download summary CSV</button></div>${summaryHTML(K,PS)}</div>
    <div class="card span-5"><div class="card-h"><h3>GST</h3><span class="note">Invoices less credit notes</span></div>${gstCardHTML(R)}</div>
    <div class="card span-7"><div class="card-h"><h3>Gross profit</h3><span class="note">Sales minus the cost of the pieces sold</span></div>${profitHTML(lines)}</div>
    <div class="card span-5"><div class="card-h"><h3>Stock movement</h3><span class="note">In and out in this period</span></div>${movementHTML(R)}</div>
    <div class="card span-7"><div class="card-h"><h3>Best sellers</h3><span class="note">Pieces sold · amount</span></div>${bestHTML(lines)}</div>
    <div class="card span-5"><div class="card-h"><div><h3>Sold by option</h3><span class="note">${OS.name?`Pieces by ${esc(OS.name.toLowerCase())}`:"Sizes, colours, storage… as your products name them"}</span></div><button class="btn xs" data-table="size" aria-pressed="${showTable.size}">${showTable.size?"Show chart":"Show table"}</button></div>${optionChipsHTML(OS)}<div id="chSize" class="chart"></div></div>
    <div class="card span-7"><div class="card-h"><h3>Top variants</h3><span class="note">Each option combination · pieces sold</span></div>${variantPerfHTML(lines)}</div>
    <div class="card span-5"><div class="card-h"><h3>Not selling</h3><span class="note">In stock, nothing sold in this period</span></div>${slowHTML(lines,R)}</div>
    <div class="card span-7"><div class="card-h"><h3>Running low now</h3><span class="note">Tap to add stock</span></div>${lowStockHTML()}</div>
    <div class="card span-5"><div class="card-h"><h3>Top customers</h3></div>${custTopHTML(live,rets)}</div>
    ${returnsHTML(rets)}
    <div class="card span-12"><div class="card-h"><h3>Product × ${esc((OS.name||"option").toLowerCase())}</h3><span class="note">Pieces sold · darker = more</span></div>${optionHeatHTML(OS)}</div>
    ${evCard}
    <div class="card span-12"><div class="card-h"><div><h3>Bills</h3><span class="note">Open a bill to print, share, return, exchange or cancel it</span></div><button class="btn xs" data-act="export">Download CSV</button></div>${billsHTML(all,R)}</div>
  </div>`;
  host.innerHTML=h;drawTime(TS);drawSizes(lines,OS);
}

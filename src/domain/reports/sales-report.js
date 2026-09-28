// Report figures, from finalized bills and returns only: their saved amounts are added up, never recalculated (no discount,
// GST or payment maths happens here). Cancelled bills are left out by the caller; returns count on the day they happened.
// Definitions (every report and the event summary use these):
//   Gross sales      what the bills came to, GST included (exchange bills too)                    Σ bill total
//   Returns          what came back, GST included (and the round off of a bill returned whole)     Σ return value
//   Total sales      gross sales − returns: what customers paid, net
//   Net sales        the taxable value of lines sold − of lines returned: revenue, without GST, after discounts
//   GST              tax on lines sold − tax reversed on returns (CGST, SGST, IGST)
//   Discounts        line and bill discounts given on the bills                                     Σ bill discount
//   Round off        the bills' round off − the round off given back
//   Refunds          money paid back on returns (an exchange's credit is not a refund)
//   Cost of goods    saved cost × pieces, for lines with a known cost, less returned pieces' cost
//   Gross profit     net sales of lines with a known cost − their cost of goods. Never guessed: the coverage (share of
//                    net sales with a known cost) is always given, and profit is only complete at 100 %.
// Pure; rupees in and out, added up in paise.
import { savedLine } from '../returns/return-value.js';
import { PAY_METHODS, paymentsOf } from '../sales/payments.js';
import { sumP, toPaise, toRupees } from '../sales/paise.js';

const R=toRupees;
/* One bill line's money: { q, amt (paid, with GST), rev (taxable), tax, cgst, sgst, igst, cost (null when unknown) } */
export function saleLineMoney(sale,i){
  const f=savedLine(sale,i);
  return {q:i.q,amt:R(f.lt),rev:R(f.tx),tax:R(f.cgst+f.sgst+f.igst),cgst:R(f.cgst),sgst:R(f.sgst),igst:R(f.igst),cost:i.cost==null?null:i.cost*i.q};
}
/* One returned line's money, negative: its saved GST when the return kept it, else its share of the bill line's */
export function returnLineMoney(sale,item){
  const v=toPaise(item.value); let t={cgst:0,sgst:0,igst:0};
  if(item.tx!=null) t={cgst:toPaise(item.cgst),sgst:toPaise(item.sgst),igst:toPaise(item.igst)};
  else{ const sl=sale&&sale.items.find((x,k)=>(x.ln!=null?x.ln:k)===item.ln);
    if(sl){ const f=savedLine(sale,sl); if(f.lt>0) t={cgst:Math.round(f.cgst*v/f.lt),sgst:Math.round(f.sgst*v/f.lt),igst:Math.round(f.igst*v/f.lt)}; } }
  const tax=t.cgst+t.sgst+t.igst;
  return {q:-item.q,amt:R(-v),rev:R(-(v-tax)),tax:R(-tax),cgst:R(-t.cgst),sgst:R(-t.sgst),igst:R(-t.igst),cost:item.cost==null?null:-item.cost*item.q};
}
/* live: bills (not cancelled) · rets: returns (not on cancelled bills) · saleById: every bill by id */
export function salesSummary(live,rets,saleById){
  const P=(list,f)=>sumP(list.map(x=>toPaise(f(x)))), bills=live.filter(s=>(s.kind||"sale")!=="exchange"), exch=live.filter(s=>s.kind==="exchange");
  const sold=[], back=[];
  live.forEach(s=>s.items.forEach(i=>sold.push(saleLineMoney(s,i))));
  rets.forEach(r=>(r.items||[]).forEach(i=>back.push(returnLineMoney(saleById&&saleById[r.sale],i))));
  const L=[...sold,...back], S=k=>P(L,x=>x[k]);
  const gross=P(live,s=>s.total), returns=P(rets,r=>r.value||0);
  const piecesSold=live.reduce((a,s)=>a+s.items.reduce((b,i)=>b+i.q,0),0), piecesReturned=rets.reduce((a,r)=>a+(r.items||[]).reduce((b,i)=>b+i.q,0),0);
  return {gross:R(gross),returns:R(returns),total:R(gross-returns),netSales:R(S("rev")),gst:R(S("tax")),cgst:R(S("cgst")),sgst:R(S("sgst")),igst:R(S("igst")),
    discounts:R(P(live,s=>s.disc||0)),roundOff:R(P(live,s=>s.roundOff||0)-P(rets,r=>r.ro||0)),refunds:R(P(rets,r=>r.refund||0)),
    bills:bills.length,avgBill:bills.length?R(Math.round(P(bills,s=>s.total)/bills.length)):0,
    exchanges:exch.length,exchangeSales:R(P(exch,s=>s.total)),exchangeCredit:R(P(exch,s=>s.credit||0)),
    returnCount:rets.filter(r=>(r.kind||"return")!=="exchange").length,exchangeReturns:rets.filter(r=>r.kind==="exchange").length,
    piecesSold,piecesReturned,pieces:piecesSold-piecesReturned};
}
/* Money by payment method: each part of a split bill counts under its own method; refunds by the method they were paid in.
   → { methods: { cash|upi|card: { in, bills, refunds, net } }, split: { bills, value }, in, refunds, net } */
export function paymentSummary(live,rets){
  const m={}; PAY_METHODS.forEach(k=>{m[k]={in:0,bills:0,refunds:0}});
  let split=0,splitV=0;
  live.forEach(s=>{const ps=paymentsOf(s); if(ps.length>1){split++;splitV+=toPaise(s.total-(s.credit||0))}
    ps.forEach(p=>{const o=m[p.method]; if(!o) return; o.in+=toPaise(p.amount); o.bills++;})});
  rets.forEach(r=>{const o=m[r.pay]; if(o&&r.refund>0) o.refunds+=toPaise(r.refund)});
  const methods={}; let tin=0,tout=0;
  PAY_METHODS.forEach(k=>{const o=m[k]; tin+=o.in; tout+=o.refunds; methods[k]={in:R(o.in),bills:o.bills,refunds:R(o.refunds),net:R(o.in-o.refunds)}});
  return {methods,split:{bills:split,value:R(splitV)},in:R(tin),refunds:R(tout),net:R(tin-tout)};
}
/* Gross profit from report lines ({ q, rev, cost }): only lines with a known cost count; coverage says how much that is.
   → { netSales, covered, uncovered, cogs, grossProfit, margin (null when nothing is covered), coverage (0–1), complete,
       piecesWithoutCost } */
export function profitSummary(lines){
  let net=0,cov=0,cogs=0,miss=0;
  (lines||[]).forEach(l=>{const r=toPaise(l.rev);net+=r;if(l.cost==null){if(l.q>0)miss+=l.q;return}cov+=r;cogs+=toPaise(l.cost)});
  const gp=cov-cogs;
  return {netSales:R(net),covered:R(cov),uncovered:R(net-cov),cogs:R(cogs),grossProfit:R(gp),margin:cov?Math.round(gp/cov*1000)/10:null,
    coverage:net?Math.round(cov/net*1000)/1000:(cov?1:0),complete:net-cov===0&&miss===0,piecesWithoutCost:miss};
}
/* Report lines grouped by a key: [{ key, q, amt, rev, cost (null when any line lacks it), first }] biggest first */
export function groupLines(lines,keyOf){
  const m={};
  (lines||[]).forEach(l=>{const k=keyOf(l); if(k==null) return; const o=m[k]||(m[k]={key:k,q:0,amt:0,rev:0,cost:0,first:l});
    o.q+=l.q; o.amt=R(toPaise(o.amt)+toPaise(l.amt)); o.rev=R(toPaise(o.rev)+toPaise(l.rev)); o.cost=o.cost==null||l.cost==null?null:o.cost+l.cost;});
  return Object.values(m).sort((a,b)=>b.q-a.q||b.amt-a.amt);
}

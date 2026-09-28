// An event's summary: its tagged bills and their returns (whenever they happened), with the report definitions of
// domain/reports/sales-report.js — sales, bills, pieces, top products and variants, cash / UPI / card, gross profit with
// its cost coverage, and GST (domain/gst/gst-report.js).
import { gstReport } from '../../../domain/gst/gst-report.js';
import { groupLines, paymentSummary, profitSummary } from '../../../domain/reports/sales-report.js';
import { D } from '../../inventory/services/ledger.js';
import { kstats, netLines } from '../../reports/services/report-data.js';
import { parseDay } from '../../../shared/formatting/dates.js';
import { moveDirection } from '../../../domain/finance/cash-moves.js';
import { sumP, toPaise, toRupees } from '../../../domain/sales/paise.js';
import { store } from '../../../shared/state/store.js';

export function eventSummary(ev){
  const d=D(), all=d.sales.filter(s=>s.event===ev.id), live=all.filter(s=>!s.void);
  const rets=d.rets.filter(r=>{const s=d.saleById[r.sale];return s&&!s.void&&s.event===ev.id});
  const lines=netLines(live,rets), end=parseDay(ev.end).getTime()+864e5;
  const G=gstReport({sales:all,returns:rets,saleById:d.saleById});
  return {K:kstats(live,rets),pay:paymentSummary(live,rets),profit:profitSummary(lines),
    products:groupLines(lines,l=>l.pid).filter(g=>g.q>0).slice(0,5),variants:groupLines(lines,l=>l.vid).filter(g=>g.q>0).slice(0,5),
    gst:G.totals.net,cancelled:all.length-live.length,postEventReturns:rets.filter(r=>r.t>=end).length,expenses:eventExpenses(ev.id)};
}
/* Expenses paid in cash at the event (less any reversed), by category */
export function eventExpenses(eid){
  const all=Object.values(store.cashMoves||{}), byId=Object.fromEntries(all.map(m=>[m.id,m])), cats={};
  all.filter(m=>m.event===eid).forEach(m=>{
    const o=m.type==="reversal"?byId[m.reverses]:m;
    if(!o||o.type!=="expense") return;
    const sign=m.type==="reversal"?(moveDirection(m,byId)==="in"?-1:1):1;
    cats[o.category]=(cats[o.category]||0)+sign*toPaise(m.amount);
  });
  const list=Object.entries(cats).filter(([,p])=>p).map(([category,p])=>({category,amount:toRupees(p)}));
  return {total:toRupees(sumP(list.map(x=>toPaise(x.amount)))),byCategory:list};
}

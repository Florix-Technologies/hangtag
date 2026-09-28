// Report summary as CSV for the chosen period and event filter: the headline figures (with what each means), payments by
// method, product, variant and customer sales, gross profit with its cost coverage, and stock movement.
import { MOVE_LABELS, MOVE_TYPES, movementTotals } from '../../../domain/inventory/stock-ledger.js';
import { groupLines, paymentSummary, profitSummary } from '../../../domain/reports/sales-report.js';
import { PAY_LABELS } from '../../../domain/sales/payments.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { dayBounds } from '../../finance/services/books-data.js';
import { kstats, netLines, periodData, periodRange } from './report-data.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { csvText } from '../../../shared/utils/csv.js';

const n2=v=>v==null?"":(Math.round((+v||0)*100)/100).toFixed(2);
export function summaryCsvRows(R){
  const {live,rets}=periodData(R.from,R.to), K=kstats(live,rets), lines=netLines(live,rets), P=profitSummary(lines), PM=paymentSummary(live,rets);
  const ev=store.prefs.repEvent, where=!ev?"Everywhere":ev==="store"?"Store only":(store.events[ev]||{}).name||ev;
  const rows=[["Hangtag sales report",R.label],["Where",where],[],["SUMMARY","Amount","What it means"]];
  [["Gross sales",K.gross,"Bills, GST included"],["Returns",-K.returns,`${K.returnCount} returns and ${K.exchangeReturns} exchanges, GST included`],["Total sales",K.total,"Gross sales less returns"],
   ["Discounts given",K.discounts,"Line and bill discounts"],["Net sales (revenue)",K.netSales,"Without GST, after discounts and returns"],["GST",K.gst,"Tax on sales less tax reversed on returns"],
   ["CGST",K.cgst,""],["SGST",K.sgst,""],["IGST",K.igst,""],["Round off",K.roundOff,""],["Refunds paid",K.refunds,"Money paid back on returns"],
   ["Exchange bills",K.exchangeSales,`${K.exchanges} bills; ${n2(K.exchangeCredit)} covered by returned items`],
   ["Bills",K.bills,"Completed, not cancelled (exchange bills not counted)"],["Pieces",K.pieces,`${K.piecesSold} sold, ${K.piecesReturned} returned`],["Average bill",K.avgBill,""],
   ["Cost of goods",P.cogs,`Known for ${Math.round(P.coverage*100)}% of net sales`],["Gross profit",P.covered?P.grossProfit:"",P.complete?`Margin ${P.margin}%`:`Only on ${n2(P.covered)} of sales with a cost price (${n2(P.uncovered)} without)`]]
    .forEach(([a,b,c])=>rows.push([a,typeof b==="number"&&!["Bills","Pieces"].includes(a)?n2(b):b,c]));
  rows.push([],["PAYMENTS","Received","Bills","Refunded","Net"]);
  Object.entries(PM.methods).forEach(([k,m])=>rows.push([PAY_LABELS[k],n2(m.in),m.bills,n2(m.refunds),n2(m.net)]));
  rows.push(["Split-payment bills",n2(PM.split.value),PM.split.bills,"",""]);
  const grp=(title,list,name)=>{rows.push([],[title,"Pieces","Sales (with GST)","Net sales","Cost of goods"]);list.forEach(g=>rows.push([name(g),g.q,n2(g.amt),n2(g.rev),g.cost==null?"unknown":n2(g.cost)]))};
  grp("PRODUCTS",groupLines(lines,l=>l.pid),g=>g.first.name);
  grp("VARIANTS",groupLines(lines,l=>l.vid),g=>g.first.name+(g.first.vl?" · "+g.first.vl:""));
  grp("CUSTOMERS",groupLines(lines.filter(l=>l.cust),l=>l.cust),g=>(store.customers[g.key]||{}).name||g.key);
  const M=movementTotals(D().ledger,dayBounds(R.from,R.to));
  rows.push([],["STOCK MOVEMENT","Pieces","Entries"]);
  MOVE_TYPES.filter(k=>M.byType[k]).forEach(k=>rows.push([MOVE_LABELS[k],M.byType[k].pieces,M.byType[k].entries]));
  rows.push(["Net change",M.net,""]);
  return rows;
}
export async function exportSummaryCsv(){
  const R=periodRange(), {all,rets}=periodData(R.from,R.to);
  if(!all.length&&!rets.length){toast("No bills in this period to download.");return}
  await use("files").saveFile(`report-${R.from}${R.to!==R.from?"-to-"+R.to:""}.csv`,"﻿"+csvText(summaryCsvRows(R)),"text/csv");
}

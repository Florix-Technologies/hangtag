// Report periods and figures.
import { legacyCS, lineLabel, vLabel } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { inFilter } from '../../../domain/events/event.js';
import { returnLineMoney, saleLineMoney, salesSummary } from '../../../domain/reports/sales-report.js';
import { D } from '../../inventory/services/ledger.js';
import { esc } from '../../../shared/dom.js';
import { addDays, dayKey, dayLab, dayLong, daysBetween, hourLab, pad, parseDay } from '../../../shared/formatting/dates.js';

/* ================= report ================= */

export function periodRange(){
  const today=dayKey(Date.now());let from,to,label,prev=null,vs="";
  if(store.prefs.period==="day"&&store.prefs.day){store.prefs.period="custom";store.prefs.from=store.prefs.to=store.prefs.day}
  switch(store.prefs.period){
    case "yesterday":from=to=addDays(today,-1);label=dayLong(from);prev={from:addDays(from,-1),to:addDays(from,-1)};vs="vs day before";break;
    case "7d":from=addDays(today,-6);to=today;label=dayLab(from)+" – "+dayLab(to);prev={from:addDays(from,-7),to:addDays(to,-7)};vs="vs previous 7 days";break;
    case "30d":from=addDays(today,-29);to=today;label=dayLab(from)+" – "+dayLab(to);prev={from:addDays(from,-30),to:addDays(to,-30)};vs="vs previous 30 days";break;
    case "all":{const s=D().sales;from=s.length?dayKey(s[0].t):today;to=today;if(from>to)from=to;label="Since "+dayLab(from);break}
    case "custom":{
      const ok=x=>/^\d{4}-\d{2}-\d{2}$/.test(x||"");
      from=ok(store.prefs.from)?store.prefs.from:today;to=ok(store.prefs.to)?store.prefs.to:from;if(to<from){const x=from;from=to;to=x}
      const n=daysBetween(from,to)+1;label=from===to?dayLong(from):dayLab(from)+" – "+dayLab(to);
      prev={from:addDays(from,-n),to:addDays(from,-1)};vs=n===1?"vs day before":"vs previous "+n+" days";break}
    default:from=to=today;label="Today · "+dayLong(today);prev={from:addDays(today,-1),to:addDays(today,-1)};vs="vs yesterday";
  }
  return {from,to,label,prev,vs};
}
export const inDays=(t,a,b)=>{const k=dayKey(t);return k>=a&&k<=b};
/* Bills and returns in a period. Cancelled bills (and returns against them) don't count. filter: "" everything, "store",
   or an event id (default: the Reports page's event filter); a return follows its original bill. */

export function periodData(from,to,filter){
  const d=D(), f=filter===undefined?(store.prefs.repEvent||""):filter;
  const all=d.sales.filter(s=>inDays(s.t,from,to)&&inFilter(s,f)).reverse(), live=all.filter(s=>!s.void);
  const rets=d.rets.filter(r=>{const s=d.saleById[r.sale]||{};return inDays(r.t,from,to)&&!s.void&&inFilter(s,f)});
  return {all,live,rets};
}
/* Every piece sold (+) and returned (−), resolved to its variant and parent product.
   amt = what the customer paid (discount and GST shared out); rev = the same without GST; cost from the bill's saved cost.
   Bills saved since line discounts keep each line's own total (lt) and taxable value (tx); older ones are shared out pro rata. */

export function netLines(live,rets){
  const d=D(), out=[];
  const who=i=>{const vid=d.resolve(i),r=vid&&d.vIdx[vid],cs=r?legacyCS(r.p.opts,r.v.o):{c:i.c||"",s:i.s||""};return {vid:vid||(i.p+":"+(i.s||"")),pid:r?r.p.id:i.p,name:r?r.p.name:i.n,c:cs.c,s:cs.s,vl:r?vLabel(r.v):lineLabel(i)}};
  live.forEach(s=>s.items.forEach(i=>out.push(Object.assign(who(i),saleLineMoney(s,i),{t:s.t,cust:s.cust&&s.cust.id||null}))));
  rets.forEach(r=>{const s=d.saleById[r.sale];r.items.forEach(i=>out.push(Object.assign(who(i),returnLineMoney(s,i),{t:r.t,cust:s&&s.cust&&s.cust.id||null})))});
  return out;
}
/* The period's headline figures (domain/reports/sales-report.js), with the names the page has always used:
   rev (total sales, net of returns), gross, retVal (returns), pcsRet, bills, pcs, dsc (discounts), avg, refunds */
export function kstats(live,rets){
  const S=salesSummary(live,rets,D().saleById);
  return {...S,rev:S.total,retVal:S.returns,pcsRet:S.piecesReturned,pcs:S.pieces,dsc:S.discounts,avg:S.avgBill};
}
export function delta(c,p,vs){if(p==null||!vs||p===0)return "";const d=(c-p)/p,pct=Math.round(Math.abs(d)*100);if(pct===0)return `<span class="delta flat">Same ${esc(vs.replace(/^vs /,"as "))}</span>`;return `<span class="delta ${d>0?"up":"down"}">${d>0?"▲":"▼"} ${pct}% <span>${esc(vs)}</span></span>`}
export function timeSeries(live,rets,R){
  const ev=[];live.forEach(s=>ev.push({t:s.t,v:s.total,n:(s.kind||"sale")!=="exchange"?1:0,p:s.items.reduce((a,i)=>a+i.q,0)}));rets.forEach(r=>ev.push({t:r.t,v:-(r.value||0),n:0,p:-r.items.reduce((a,i)=>a+i.q,0)}));
  const rows=[],add=(by,k,e)=>{const o=by[k]||(by[k]={v:0,n:0,p:0});o.v+=e.v;o.n+=e.n;o.p+=e.p};
  if(R.from===R.to){
    const by={};ev.forEach(e=>add(by,new Date(e.t).getHours(),e));
    const hs=Object.keys(by).map(Number);
    if(hs.length){let a=Math.min(...hs),b=Math.max(...hs);while(b-a<5){if(a>0)a--;if(b-a<5&&b<23)b++}
      for(let h=a;h<=b;h++){const o=by[h]||{v:0,n:0,p:0};rows.push({short:hourLab(h),label:hourLab(h)+" – "+hourLab((h+1)%24),v:o.v,n:o.n,p:o.p})}}
    return {title:"Sales by hour",unit:"Time",rows,labelW:32};
  }
  const span=daysBetween(R.from,R.to);
  if(span<=62){
    const by={};ev.forEach(e=>add(by,dayKey(e.t),e));
    for(let i=0;i<=span;i++){const k=addDays(R.from,i),o=by[k]||{v:0,n:0,p:0};rows.push({short:span<=7?parseDay(k).toLocaleDateString("en-IN",{weekday:"short"}):String(parseDay(k).getDate()),label:dayLong(k),v:o.v,n:o.n,p:o.p})}
    return {title:"Sales by day",unit:"Day",rows,labelW:span<=7?32:20};
  }
  const by={};ev.forEach(e=>add(by,dayKey(e.t).slice(0,7),e));
  let y=+R.from.slice(0,4),m=+R.from.slice(5,7);const ey=+R.to.slice(0,4),em=+R.to.slice(5,7);
  while(y<ey||(y===ey&&m<=em)){const k=y+"-"+pad(m),o=by[k]||{v:0,n:0,p:0},d=new Date(y,m-1,1);rows.push({short:d.toLocaleDateString("en-IN",{month:"short"}),label:d.toLocaleDateString("en-IN",{month:"long",year:"numeric"}),v:o.v,n:o.n,p:o.p});m++;if(m>12){m=1;y++}}
  return {title:"Sales by month",unit:"Month",rows,labelW:30};
}
export function byProduct(lines){const m={};lines.forEach(l=>{const o=m[l.pid]||(m[l.pid]={id:l.pid,n:l.name,q:0,a:0});o.q+=l.q;o.a+=l.amt});return m}

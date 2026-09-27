// Report periods and figures.
import { legacyCS, lineLabel, vLabel } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { pcsOf } from '../../../domain/sales/sale.js';
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
/* Bills and returns in a period. Cancelled bills (and returns against them) don't count. */

export function periodData(from,to){
  const d=D(), all=d.sales.filter(s=>inDays(s.t,from,to)).reverse(), live=all.filter(s=>!s.void);
  const rets=d.rets.filter(r=>inDays(r.t,from,to)&&!(d.saleById[r.sale]||{}).void);
  return {all,live,rets};
}
/* Every piece sold (+) and returned (−), resolved to its variant and parent product.
   amt = what the customer paid (discount and GST shared out); rev = the same without GST; cost from the bill's saved cost.
   Bills saved since line discounts keep each line's own total (lt) and taxable value (tx); older ones are shared out pro rata. */

export function netLines(live,rets){
  const d=D(), out=[];
  const who=i=>{const vid=d.resolve(i),r=vid&&d.vIdx[vid],cs=r?legacyCS(r.p.opts,r.v.o):{c:i.c||"",s:i.s||""};return {vid:vid||(i.p+":"+(i.s||"")),pid:r?r.p.id:i.p,name:r?r.p.name:i.n,c:cs.c,s:cs.s,vl:r?vLabel(r.v):lineLabel(i)}};
  live.forEach(s=>{const ratio=s.sub>0?s.total/s.sub:1,exTax=s.total?(s.total-(s.tax||0))/s.total:1;
    s.items.forEach(i=>{const amt=i.lt!=null?i.lt:i.q*i.price*ratio;out.push(Object.assign(who(i),{q:i.q,amt,rev:i.tx!=null?i.tx:amt*exTax,cost:i.cost==null?null:i.cost*i.q,t:s.t}))})});
  rets.forEach(r=>{const s=d.saleById[r.sale],exTax=s&&s.total?(s.total-(s.tax||0))/s.total:1;
    r.items.forEach(i=>{const sl=s&&s.items.find(x=>x.ln===i.ln),ex=sl&&sl.lt?sl.tx/sl.lt:exTax;out.push(Object.assign(who(i),{q:-i.q,amt:-(i.value||0),rev:-(i.value||0)*ex,cost:i.cost==null?null:-i.cost*i.q,t:r.t}))})});
  return out;
}
export function kstats(live,rets){
  const bills=live.filter(s=>(s.kind||"sale")!=="exchange");
  const gross=live.reduce((a,s)=>a+s.total,0), retVal=rets.reduce((a,r)=>a+(r.value||0),0);
  const pcsSold=live.reduce((a,s)=>a+pcsOf(s),0), pcsRet=rets.reduce((a,r)=>a+r.items.reduce((b,i)=>b+i.q,0),0);
  const rev=gross-retVal, billRev=bills.reduce((a,s)=>a+s.total,0);
  return {rev,gross,retVal,pcsRet,bills:bills.length,pcs:pcsSold-pcsRet,dsc:live.reduce((a,s)=>a+(s.disc||0),0),avg:bills.length?billRev/bills.length:0,refunds:rets.reduce((a,r)=>a+(r.refund||0),0)};
}
export function delta(c,p,vs){if(p==null||!vs||p===0)return "";const d=(c-p)/p,pct=Math.round(Math.abs(d)*100);if(pct===0)return `<span class="delta flat">Same ${esc(vs.replace(/^vs /,"as "))}</span>`;return `<span class="delta ${d>0?"up":"down"}">${d>0?"▲":"▼"} ${pct}% <span>${esc(vs)}</span></span>`}
export function timeSeries(live,rets,R){
  const ev=[];live.forEach(s=>ev.push({t:s.t,v:s.total,n:(s.kind||"sale")!=="exchange"?1:0,p:pcsOf(s)}));rets.forEach(r=>ev.push({t:r.t,v:-(r.value||0),n:0,p:-r.items.reduce((a,i)=>a+i.q,0)}));
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

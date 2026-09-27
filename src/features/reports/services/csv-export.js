// CSV export of the selected period.
import { PAYN } from '../../../domain/sales/sale.js';
import { D } from '../../inventory/services/ledger.js';
import { periodData, periodRange } from './report-data.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { dayKey, hhmm } from '../../../shared/formatting/dates.js';

export async function exportCsv(){
  const R=periodRange(),{all,rets}=periodData(R.from,R.to);
  if(!all.length&&!rets.length){toast("No bills in this period to download.");return}
  const rows=[["Date","Time","Type","Bill no","Bill ID","Customer","Product","Colour","Size","SKU","Qty","Unit price","Line amount","Unit cost","Bill discount","GST","Bill total","Payment","Cancelled"]];
  all.slice().reverse().forEach(s=>s.items.forEach((i,k)=>rows.push([dayKey(s.t),hhmm(s.t),s.kind==="exchange"?"Exchange sale":"Sale",s.no||"",s.id,s.cust?s.cust.name:"",i.n,i.c||"",i.s||"",i.sku||"",i.q,i.price,i.q*i.price,i.cost==null?"":i.cost,k===0?(s.disc||0):"",k===0?(s.tax||0):"",k===0?s.total:"",PAYN[s.pay]||s.pay,s.void?"yes":""])));
  rets.forEach(r=>{const s=D().saleById[r.sale]||{};r.items.forEach((i,k)=>rows.push([dayKey(r.t),hhmm(r.t),r.kind==="exchange"?"Exchange return":"Return",s.no||"",r.sale,s.cust?s.cust.name:"",i.n,i.c||"",i.s||"",i.sku||"",-i.q,i.price,-(i.value||0),i.cost==null?"":i.cost,"","",k===0?-(r.refund||0):"",PAYN[r.pay]||r.pay||"",""]))});
  const csv=rows.map(r=>r.map(v=>{v=String(v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}).join(",")).join("\n");
  await use("files").saveFile(`sales-${R.from}${R.to!==R.from?"-to-"+R.to:""}.csv`,"﻿"+csv,"text/csv");
}

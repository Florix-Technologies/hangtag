// Bills saved on this device and today's figures.
import { store } from '../../../shared/state/store.js';
import { pcsOf } from '../../../domain/sales/sale.js';
import { D } from '../../inventory/services/ledger.js';
import { dayKey } from '../../../shared/formatting/dates.js';

export function todayStats(){const k=dayKey(Date.now());let rev=0,bills=0,pcs=0;D().sales.forEach(s=>{if(s.void||dayKey(s.t)!==k)return;rev+=s.total-(s.credit||0);bills++;pcs+=pcsOf(s)});D().rets.forEach(r=>{if(dayKey(r.t)===k)rev-=r.refund||0});return{rev,bills,pcs}}
export function billNo(){const k=dayKey(Date.now());return D().sales.filter(s=>dayKey(s.t)===k).length+1}
export const isVoid=id=>{const s=D().saleById[id];return !!(s&&s.void)};
/* ================= local document helper ================= */

export function myOpenDocId(){
  const d=dayKey(Date.now());let n=0;
  while(store.localDays[`${d}_${store.dev}_${n}`]&&(store.localDays[`${d}_${store.dev}_${n}`].sales||[]).length>=700)n++;
  const id=`${d}_${store.dev}_${n}`;
  if(!store.localDays[id]){const r=store.remoteDays[id];store.localDays[id]=r?JSON.parse(JSON.stringify(r)):{date:d,dev:store.dev,chunk:n,sales:[],voids:[]}}
  if(!store.localDays[id].voids)store.localDays[id].voids=[];
  return id;
}

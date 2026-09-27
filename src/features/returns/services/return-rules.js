// Return values and limits.
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { stockOf } from '../../inventory/services/stock.js';

/* What was paid per piece on this bill line (discount and GST shared out proportionally) */

export function unitValue(s,i){ const ratio=s.sub>0?s.total/s.sub:1; return Math.round(i.price*ratio*100)/100; }
export function returnable(s,i,k){ const ln=i.ln!=null?i.ln:k; return Math.max(0,i.q-(D().retLine[s.id+"|"+ln]||0)); }
export function retValue(){ const s=D().saleById[store.retState.sid]; return s.items.reduce((a,i,k)=>{const ln=i.ln!=null?i.ln:k,q=store.retState.q[ln]||0;return a+Math.round(q*unitValue(s,i))},0); }
export function exAvail(vid){ // stock for exchange items, counting what's being returned in this same exchange
  let back=0; const s=store.retState&&D().saleById[store.retState.sid];
  if(s) s.items.forEach((i,k)=>{const ln=i.ln!=null?i.ln:k;if(D().resolve(i)===vid)back+=store.retState.q[ln]||0});
  return stockOf(vid)+back-(store.retState?store.retState.newItems.filter(c=>c.v===vid).reduce((a,c)=>a+c.q,0):0);
}

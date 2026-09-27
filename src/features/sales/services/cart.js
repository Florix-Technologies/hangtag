// Cart lines and quantities.
import { legacyCS, optionSnapshot } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { vCost, vLabel, vPrice } from '../../../domain/catalog/variants.js';
import { stockOf } from '../../inventory/services/stock.js';
import { vRec } from '../../inventory/services/ledger.js';
import { toast } from '../../../shared/components/toast.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { okColor } from '../../../shared/utils/colors.js';

export const cartQtyV=vid=>store.cart.reduce((a,c)=>a+(c.v===vid?c.q:0),0);
export const cartQtyP=pid=>store.cart.reduce((a,c)=>a+(c.p===pid?c.q:0),0);
export const availOf=vid=>stockOf(vid)-cartQtyV(vid);
export const cartPcs=()=>store.cart.reduce((a,c)=>a+c.q,0);
export const cartSub=()=>store.cart.reduce((a,c)=>a+c.q*c.price,0);
/* one line per variant, with name / colour / size / price / cost copied at the time of sale */

export function addToLines(lines,vid,q){
  const r=vRec(vid); if(!r) return;
  const ex=lines.find(c=>c.v===vid);
  if(ex) ex.q+=q;
  else lines.push({v:vid,p:r.p.id,name:r.p.name,...legacyCS(r.p.opts,r.v.o),vl:vLabel(r.v),ov:optionSnapshot(r.p,r.v),sku:r.v.sku||"",q,price:vPrice(r.p,r.v),cost:vCost(r.p,r.v),color:okColor(r.p.color)});
}
export function addOne(vid){
  const r=vRec(vid); if(!r) return;
  if(availOf(vid)<=0){ toast(`${r.p.name} ${vLabel(r.v)} is sold out.`); return; }
  addToLines(store.cart,vid,1); store.justAdded=r.p.id; saveCart(); renderAll();
  toast(`Added ${r.p.name}${vLabel(r.v)?" · "+vLabel(r.v):""}.`);
}

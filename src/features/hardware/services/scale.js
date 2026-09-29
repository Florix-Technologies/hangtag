// The weighing scale of this device, through the "weightScale" port (infrastructure/hardware/weight-scale.js).
import { use } from '../../../shared/di/services.js';
import { convertQty, qtyText, unitOf } from '../../../domain/catalog/units.js';

export const weightScale=()=>use("weightScale");
/* Can this browser reach a scale on a cable, and is one connected? */
export const scaleSupported=()=>{ try{ return !!weightScale().supported(); }catch{ return false; } };
export const scaleStatus=()=>{ try{ return weightScale().status(); }catch{ return {connected:false,kind:"manual",name:""}; } };
/* A reading from the scale in the product's unit → { q, text } or { error }. A reading in another unit of the same kind is
   converted (a scale in g for a product sold by the kg); one of another kind (kg for a product sold by the litre) is refused. */
export async function readScaleFor(unit){
  let r;
  try{ r=await weightScale().read({timeoutMs:3000}); }catch{ r={error:"The scale couldn't be read. Type the weight."}; }
  if(!r||r.error) return {error:r&&r.error||"The scale couldn't be read. Type the weight."};
  if(!(r.value>0)) return {error:"The scale shows nothing on it (or less than zero). Put the item on the scale, or type the weight."};
  const u=unitOf(unit), q=convertQty(r.value,r.unit,u.id);
  if(q==null) return {error:`The scale reads in ${r.unit}, but this is sold by the ${u.label.toLowerCase()}. Type the quantity instead.`};
  if(!(q>0)) return {error:`That is less than the smallest amount sold (${qtyText(10**-u.dp,u.id)}). Type the quantity.`};
  return {q,text:qtyText(q,u.id)};
}
/* At start-up: open the scale this browser remembers (no prompt), when this device is set to */
export async function reconnectScale(auto){
  if(!auto||!scaleSupported()) return false;
  try{ return await weightScale().reconnect(); }catch{ return false; }
}

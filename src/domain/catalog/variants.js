// Variant rules: active variants, price/cost inheritance, labels, price range.
import { inr } from '../../shared/formatting/money.js';

export const variantsOf=(p,all)=>((p&&p.variants)||[]).filter(v=>all||v.active!==false);
export const numOrNull=x=>(x===null||x===undefined||x==="")?null:Math.max(0,Math.round(+x||0));
export const vPrice=(p,v)=>v&&v.price!=null&&v.price!==""?+v.price:(+p.price||0);
export const vCost=(p,v)=>v&&v.cost!=null&&v.cost!==""?+v.cost:(p&&p.cost!=null&&p.cost!==""?+p.cost:null);
// Labels come from the variant's option values (see ./options.js)
export { vLabel, lineLabel } from './options.js';
export function priceRange(p){const ps=variantsOf(p).map(v=>vPrice(p,v));if(!ps.length)return inr(p.price);const a=Math.min(...ps),b=Math.max(...ps);return a===b?inr(a):inr(a)+"–"+inr(b).slice(1)}

// Catalog queries over the local product list.
import { isSizeOption } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { upgradeCatalog } from '../../../domain/catalog/catalog-migration.js';
import { szRank } from '../../../domain/catalog/sizes.js';
import { saveCatalog, saveMoves } from '../../../shared/state/persistence.js';

/* Upgrade an older catalog format (the opening-stock moves it implies carry this device's id) */
export const migrateCatalog=cat=>upgradeCatalog(cat,{deviceId:store.dev,now:Date.now()});
export function applyCatalogMigration(){
  const m=migrateCatalog(store.catalog);
  if(m.cat!==store.catalog){store.catalog=m.cat;m.moves.forEach(x=>{if(!store.moves[x.id])store.moves[x.id]=x});saveCatalog();saveMoves()}
}
export const products=()=>(store.catalog&&Array.isArray(store.catalog.products))?store.catalog.products:[];
export const liveProducts=()=>products().filter(p=>!p.archived);
export const prod=id=>products().find(p=>p.id===id);
export function sizeOrder(extra){const seen=[];products().forEach(p=>(p.opts||[]).filter(o=>isSizeOption(o.n)).forEach(o=>o.v.forEach(s=>{if(!seen.includes(s))seen.push(s)})));(extra||[]).forEach(s=>{if(s!==""&&!seen.includes(s))seen.push(s)});return seen.map((s,i)=>({s,i,r:szRank(s)})).sort((a,b)=>a.r-b.r||a.i-b.i).map(o=>o.s)}
export function categories(){ return [...new Set(products().map(p => p.cat).filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }

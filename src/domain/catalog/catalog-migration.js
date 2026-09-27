// Catalog format upgrades (size-only v1 -> colour+size v2 -> any options v3).
import { okColor } from '../../shared/utils/colors.js';
import { migrateCatalogV3 } from './options.js';

/* ================= catalog model =================
   catalog = {version:2, example, products:[{id, name, cat, brand, desc, price, cost, color, archived,
              colors:[names], sizes:[labels], variants:[{id, c, s, sku, bc, price, cost, active}]}]}
   Every colour + size combination is a variant. Stock is never stored as a number: it is
   opening + stock in + adjustments (moves) − sold (bills) + returned (returns), per variant. */

/* Returns { cat, moves }: the upgraded (v3) catalog and the opening-stock moves it implies (deviceId/now stamp them) */
export function upgradeCatalog(cat,opts){const r=upgradeToV2(cat,opts);return {cat:migrateCatalogV3(r.cat),moves:r.moves}}
function upgradeToV2(cat,{deviceId,now}){
  // Old catalogs had products with sizes:[{s, stock}] where stock = pieces received.
  if(!cat||!Array.isArray(cat.products))return {cat,moves:[]};
  if(cat.version>=2)return {cat,moves:[]};
  const newMoves=[];
  const products=cat.products.map(p=>{
    const list=Array.isArray(p.sizes)?p.sizes:[];
    const sizes=list.map(z=>String(z.s));
    const variants=list.map(z=>({id:p.id+":"+z.s,c:"",s:String(z.s),sku:"",bc:"",price:null,cost:null,active:true}));
    list.forEach(z=>{const q=Math.round(+z.stock||0);if(q)newMoves.push({id:"open:"+p.id+":"+z.s,v:p.id+":"+z.s,p:p.id,type:"OPENING",q,cost:null,note:"Opening stock (moved from the old size list)",t:now,dev:deviceId})});
    if(!variants.length)variants.push({id:p.id+":",c:"",s:"",sku:"",bc:"",price:null,cost:null,active:true});
    return {id:p.id,name:String(p.name||"Untitled"),cat:"",brand:"",desc:"",price:Math.max(0,Math.round(+p.price||0)),cost:null,color:okColor(p.color),archived:false,colors:[],sizes,variants};
  });
  return {cat:{version:2,example:!!cat.example,products},moves:newMoves};
}

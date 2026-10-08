// SaveProduct: check the editor's draft with the product rules, work out the variants and stock moves, and store it.
import { store } from '../../../shared/state/store.js';
import { takenCodes, validateProductDraft } from '../../../domain/catalog/product-validation.js';
import { numOrNull, variantsOf } from '../../../domain/catalog/variants.js';
import { cleanOptionName, editorCombos, removedCells } from '../../../domain/catalog/options.js';
import { cleanCode } from '../../../domain/catalog/barcode.js';
import { hasHistory, hasMoves } from '../../inventory/services/ledger.js';
import { stockOf } from '../../inventory/services/stock.js';
import { productRepository } from '../repositories/product-repository.js';
import { uid } from '../../../shared/utils/ids.js';
import { okColor } from '../../../shared/utils/colors.js';
import { UPLOAD_PERMISSIONS } from '../../../domain/sync/queue-rules.js';
import { canAny, denied, notAllowedText } from '../../shop/services/access.js';
import { cleanTracking, trackingFromChoice } from '../../../domain/shop/capabilities.js';
import { decimalsOf, isWeighed, roundQty, unitId } from '../../../domain/catalog/units.js';
import { hasCap } from '../../shop/services/shop-caps.js';

/* draft: the editor state { id, name, cat, brand, desc, price, cost, color, archived, hsn, gst, unit, tracking, hasOpts, opts, cells, codesOn, code, img }
   (opts/cells as in domain/catalog/options.js). Every current combination is saved as a variant (off sale when unticked);
   a saved variant that is no longer a combination is kept, off sale and with its stock zeroed, when it has stock history
   or sales, and deleted otherwise. Returns { error } (nothing saved) or { created, name, activeCount, variantCount, ids }
   where ids maps each combination's cell key to its variant id. A team member needs manage_products, and a stock
   permission when the save changes stock (opening stock, a changed count): refused before anything changes. */
export function saveProduct({ draft }){
  const no=denied("manage_products","add or edit products"); if(no) return no;
  const e=draft, repo=productRepository();
  const combos=editorCombos(e), removed=removedCells(e);
  const kept=removed.filter(({cell})=>hasHistory(cell.id)||hasMoves(cell.id));
  const ok=validateProductDraft(e,combos,kept,takenCodes(repo.list(),e.id,variantsOf));
  if(ok.error)return {error:ok.error};
  const {name,price,cost,hsn,gst}=ok;
  // the unit it is sold in: stock counts keep its decimals (12.5 kg), whole numbers for pieces
  const old=repo.get(e.id), t=Date.now(), unit=unitId(e.unit), dp=decimalsOf(unit);
  // tracked by serial number or batch: its stock moves only with its serials / batches (Purchases, Stock in, bills), and how
  // it is tracked changes only while it has no stock (pieces already in hand have no serials or batch to go by)
  const trk=trackingFromChoice(e.tracking), wasTrk=cleanTracking(old&&old.tracking);
  // a capability the shop has switched off can't be started on a product (one already using it keeps working)
  const capOff=(cap,what)=>({error:`${what} ${what.endsWith("s")?"are":"is"} switched off for this shop. Switch it on in Settings → Business → Features first.`,cap});
  if(trk.tracking==="serial"&&wasTrk!=="serial"&&!hasCap("uses_serials")) return capOff("uses_serials","Serial numbers");
  if(trk.tracking==="batch"&&wasTrk!=="batch"&&!hasCap("uses_batches")) return capOff("uses_batches","Batch tracking");
  if(trk.expiry&&!(old&&old.expiry)&&!hasCap("uses_expiry")) return capOff("uses_expiry","Expiry dates");
  if(isWeighed(unit)&&!(old&&isWeighed(unitId(old.unit)))&&!hasCap("uses_weight")) return capOff("uses_weight","Selling by weight");
  if(old&&trk.tracking!==wasTrk&&variantsOf(old,true).some(v=>stockOf(v.id)!==0)) return {error:`How ${old.name} is tracked can change only while it has no stock. It has ${variantsOf(old,true).reduce((a,v)=>a+Math.max(0,stockOf(v.id)),0)} in hand: sell or adjust it to 0 first.`};
  const variants=[], newMoves=[], delV=[], ids={}; let bad=null;
  const fields=cell=>({sku:String(cell.sku||"").trim(),bc:cleanCode(cell.bc),price:numOrNull(cell.price),cost:numOrNull(cell.cost)});
  combos.forEach(({o,key,cell})=>{
    const id=cell.id||("v"+uid());ids[key]=id;
    variants.push({id,o:o.slice(),...fields(cell),active:cell.active!==false});
    const want=cell.stock===""||cell.stock==null?0:roundQty(+cell.stock,dp), cur=cell.exists?stockOf(id):0, dq=roundQty(want-cur);
    if(dq&&trk.tracking!=="none") bad=bad||`Stock of a product tracked by ${trk.tracking==="serial"?"serial number":"batch"} comes in through Purchases or Stock in: leave the stock boxes as they are.`;
    if(dq) newMoves.push({id:(cell.exists?"m":"open:")+(cell.exists?uid():id),v:id,p:e.id,type:cell.exists?"ADJUST":"OPENING",q:dq,cost:null,note:cell.exists?"Changed in the product editor":"Opening stock",t,dev:store.dev});
  });
  removed.forEach(({cell})=>{
    if(kept.some(k=>k.cell===cell)){
      const cur=stockOf(cell.id);
      variants.push({id:cell.id,o:cell.o.slice(),...fields(cell),active:false});
      if(cur>0&&wasTrk!=="none") bad=bad||`A variant with stock can't be removed from a product tracked by ${wasTrk==="serial"?"serial number":"batch"}: take its stock out first (Stock → Adjust).`;
      if(cur>0)newMoves.push({id:"m"+uid(),v:cell.id,p:e.id,type:"ADJUST",q:-cur,cost:null,note:"Variant removed in the product editor",t,dev:store.dev});
    }else delV.push(cell.id);
  });
  if(bad) return {error:bad};
  if(newMoves.length&&!canAny(UPLOAD_PERMISSIONS.move)) return {error:notAllowedText("set stock")+" Leave the stock numbers as they are."};
  const opts=e.hasOpts?e.opts.map(op=>({n:cleanOptionName(op.n),v:op.v.slice()})):[];
  // what the editor doesn't show stays as it is: the product's own low-stock alert (from an import), its repack conversions
  // and a kit's items
  const unseen=old?Object.fromEntries(["low","repack","bundle"].filter(k=>old[k]!=null).map(k=>[k,old[k]])):{};
  const product={...unseen,id:e.id,name,cat:String(e.cat||"").trim(),brand:String(e.brand||"").trim(),desc:String(e.desc||"").trim(),price,cost,color:okColor(e.color),archived:!!e.archived,
    hsn,gst,code:e.codesOn?(e.code==="qr"?"qr":"barcode"):"",opts,variants,...(unit!=="pcs"?{unit}:{})};
  if(trk.tracking!=="none") product.tracking=trk.tracking;   // serial | batch (none: not stored)
  if(trk.expiry) product.expiry=true;   // a batch-tracked product whose batches have expiry dates
  repo.save({product,isNew:!old,renamed:!!old&&old.name!==name,newMoves,deletedVariantIds:delV,image:e.img});
  const active=variants.filter(v=>v.active);
  return {created:!old,name,activeCount:active.length,variantCount:variants.length,ids};
}

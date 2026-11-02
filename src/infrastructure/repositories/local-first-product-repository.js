// The "productRepository" port: products live on this device first (the state store + its storage),
// and every change is queued for upload. Dependencies are passed in by app/container.js.
import { variantsOf } from '../../domain/catalog/variants.js';
import { productChanges } from '../../domain/catalog/product-changes.js';

/* store: the state store · persist: { saveCatalog, saveMoves, saveImgs, saveSbQueue } · outbox: { enqueue, dropQueued } */
export function createLocalFirstProductRepository({ store, persist, outbox }){
  const list = () => (store.catalog && Array.isArray(store.catalog.products)) ? store.catalog.products : [];
  return {
    list,
    get: id => list().find(p => p.id === id),
    /* A new or edited product, its new stock moves, the variant ids removed for good, and its photo
       (image: a data URL, "" to remove it, or undefined to leave it). An edit uploads what it changed — the product's fields
       and the variants added or changed (domain/catalog/product-changes.js) — so another till's edit of the same product
       isn't overwritten; a new product goes up whole, and so does one changed in place (nothing to compare it with). */
    save({ product, isNew, renamed, newMoves, deletedVariantIds, image }){
      if(!store.catalog||!Array.isArray(store.catalog.products))store.catalog={version:3,example:false,products:[]};
      const before=isNew?null:list().find(x=>x.id===product.id), ch=before&&before!==product?productChanges(before,product):null;
      if(!isNew)store.catalog.products=store.catalog.products.map(x=>x.id===product.id?product:x);else store.catalog.products.push(product);
      if(store.catalog.example&&!isNew&&renamed)store.catalog.example=false;
      persist.saveCatalog();
      newMoves.forEach(m=>{store.moves[m.id]=m});persist.saveMoves();
      deletedVariantIds.forEach(id=>Object.keys(store.moves).forEach(k=>{if(store.moves[k].v===id)delete store.moves[k]}));
      if(image!==undefined){if(image)store.imgs[product.id]=image;else delete store.imgs[product.id];persist.saveImgs();outbox.enqueue({type:"img",id:product.id})}
      if(!ch||ch.fields.length||ch.variants.length||deletedVariantIds.length) outbox.enqueue({type:"prod",id:product.id,delV:deletedVariantIds,...(ch?{fields:ch.fields,vars:ch.variants}:{})});
      newMoves.forEach(m=>outbox.enqueue({type:"move",id:m.id,move:m}));
    },
    /* Many new products at once (bulk import) with their opening stock records: the catalog and the stock records are saved
       once, then each product and record is queued (products first) */
    addMany({ products, moves }){
      if(!store.catalog||!Array.isArray(store.catalog.products))store.catalog={version:3,example:false,products:[]};
      store.catalog.products.push(...products);persist.saveCatalog();
      moves.forEach(m=>{store.moves[m.id]=m});persist.saveMoves();
      products.forEach(p=>outbox.enqueue({type:"prod",id:p.id}));
      moves.forEach(m=>outbox.enqueue({type:"move",id:m.id,move:m}));
    },
    setArchived(id, on){
      const p = list().find(x => x.id === id); if(!p) return null;
      p.archived=on;persist.saveCatalog();outbox.enqueue({type:"prod",id,fields:["archived"],vars:[]});
      return p;
    },
    /* Remove a product with its stock records and photo (only for products that were never sold) */
    remove(id){
      const p = list().find(x => x.id === id); if(!p) return null;
      store.catalog.products=list().filter(x=>x.id!==id);persist.saveCatalog();
      const vids=new Set(variantsOf(p,true).map(v=>v.id));Object.keys(store.moves).forEach(k=>{if(vids.has(store.moves[k].v))delete store.moves[k]});persist.saveMoves();
      delete store.imgs[id];persist.saveImgs();
      outbox.dropQueued(q=>(q.type==="move"&&q.move&&vids.has(q.move.v))||(q.type==="prod"&&q.id===id));
      outbox.enqueue({type:"proddel",id});
      return p;
    },
  };
}

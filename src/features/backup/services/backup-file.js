// Backup file: create, check, apply.
import { store } from '../../../shared/state/store.js';
import { migrateCatalog } from '../../products/services/catalog.js';
import { D } from '../../inventory/services/ledger.js';
import { products } from '../../products/services/catalog.js';
import { pushLocalToSupabase } from '../../sync/services/pull.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { $ } from '../../../shared/dom.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { persistLocal, saveCatalog, saveCustomers, saveImgs, saveMoves, saveReturns } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { objOr } from '../../../shared/utils/objects.js';

/* ================= backup + restore ================= */

export async function downloadBackup(){
  const data={app:"hangtag",version:4,exportedAt:new Date().toISOString(),profile:store.profile||null,settings:store.settings,catalog:store.catalog,images:store.imgs,
    days:Object.assign({},store.remoteDays,store.localDays),moves:store.moves,returns:store.returnsMap,customers:store.customers};
  if(await use("files").saveFile(`hangtag-backup-${dayKey(Date.now())}.json`,JSON.stringify(data),"application/json"))toast("Backup downloaded.");
}
/* Check a backup file before anything changes; returns what a restore would do */

export function inspectBackup(data){
  const errs=[];
  if(!data||data.app!=="hangtag")return {ok:false,errs:["This file isn't a Hangtag backup."]};
  if(!data.days||typeof data.days!=="object")errs.push("The bills section is missing.");
  const mig=migrateCatalog(data.catalog&&Array.isArray(data.catalog.products)?data.catalog:{version:3,products:[]});
  const bprods=mig.cat.products||[];
  bprods.forEach((p,i)=>{if(!p||!p.id||!Array.isArray(p.variants))errs.push(`Product ${i+1} is damaged.`)});
  if(errs.length)return {ok:false,errs};
  const have=new Set(products().map(p=>p.id)),haveSales=new Set(D().sales.map(s=>s.id));
  let bills=0,newBills=0;
  Object.values(data.days).forEach(doc=>(doc&&Array.isArray(doc.sales)?doc.sales:[]).forEach(s=>{if(s&&s.id&&Array.isArray(s.items)){bills++;if(!haveSales.has(s.id))newBills++}}));
  const bm=Object.assign({},objOr(data.moves,{}));mig.moves.forEach(m=>{if(!bm[m.id])bm[m.id]=m});
  const br=objOr(data.returns,{}),bc=objOr(data.customers,{});
  return {ok:true,data,cat:mig.cat,moves:bm,returns:br,customers:bc,
    summary:{products:bprods.length,newProducts:bprods.filter(p=>!have.has(p.id)).length,variants:bprods.reduce((a,p)=>a+p.variants.length,0),
      bills,newBills,moves:Object.keys(bm).length,newMoves:Object.keys(bm).filter(k=>!store.moves[k]).length,
      returns:Object.keys(br).length,newReturns:Object.keys(br).filter(k=>!store.returnsMap[k]).length,
      customers:Object.keys(bc).length,newCustomers:Object.keys(bc).filter(k=>!store.customers[k]).length,
      exportedAt:data.exportedAt||""}};
}
export function applyRestore(){
  const r=store.restoreCheck;if(!r)return;
  const replace=!!($("#rsReplace")||{}).checked,data=r.data;
  const cur=products(),byId={};cur.forEach((p,i)=>{byId[p.id]=i});
  const list=cur.slice();
  r.cat.products.forEach(p=>{if(byId[p.id]==null)list.push(p);else if(replace)list[byId[p.id]]=p});
  store.catalog={version:3,example:false,products:list};saveCatalog();
  if(data.images&&typeof data.images==="object")Object.keys(data.images).forEach(id=>{const src=data.images[id];if(typeof src==="string"&&src.indexOf("data:image/")===0&&(!store.imgs[id]||replace))store.imgs[id]=src});
  saveImgs();
  Object.entries(r.moves).forEach(([k,m])=>{if(!store.moves[k]&&m&&m.v)store.moves[k]=m});saveMoves();
  Object.entries(r.returns).forEach(([k,x])=>{if(!store.returnsMap[k]&&x&&Array.isArray(x.items))store.returnsMap[k]=x});saveReturns();
  Object.entries(r.customers).forEach(([k,c])=>{if(!store.customers[k]&&c&&c.name)store.customers[k]=c});saveCustomers();
  let added=0;
  Object.keys(data.days||{}).forEach(id=>{
    const doc=data.days[id];if(!doc||!Array.isArray(doc.sales)||!/^[A-Za-z0-9_.-]+$/.test(id))return;
    let curDoc=store.localDays[id]||(store.remoteDays[id]?JSON.parse(JSON.stringify(store.remoteDays[id])):null);
    if(!curDoc){curDoc=JSON.parse(JSON.stringify(doc));if(!curDoc.voids)curDoc.voids=[];store.localDays[id]=curDoc;store.dirty.add(id);added+=curDoc.sales.length;return}
    store.localDays[id]=curDoc;if(!curDoc.voids)curDoc.voids=[];
    const have=new Set(curDoc.sales.map(s=>s.id));let ch=false;
    doc.sales.forEach(s=>{if(s&&s.id&&Array.isArray(s.items)&&!have.has(s.id)&&!D().saleById[s.id]){curDoc.sales.push(s);added++;ch=true}});
    (doc.voids||[]).forEach(v=>{if(!curDoc.voids.includes(v)){curDoc.voids.push(v);ch=true}});
    if(ch)store.dirty.add(id);
  });
  persistLocal();store.restoreCheck=null;closeModal();renderAll();
  toast(`Backup restored — ${added} bill${added===1?"":"s"} added.`);
  pushLocalToSupabase();
}

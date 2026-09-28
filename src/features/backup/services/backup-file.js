// Backup file: create, check, restore.
//   · A backup (version 5) holds the shop's data — profile, settings, products and variants, photos, bills, stock history,
//     returns, customers, events and the receipt logo — with the shop's identity (account id and name), when it was made,
//     record counts, and a SHA-256 of its contents. No secrets: no sign-in session, no upload queue, no device printer
//     settings, and any field named like a key, token, secret or password is left out.
//   · Checking comes first and changes nothing: not a Hangtag file, a damaged file (the SHA-256 doesn't match), a file from
//     a newer Hangtag, or another shop's backup (only allowed into an empty shop) are refused with the reason.
//   · Restoring only adds what this device doesn't have (optionally replacing products), all or nothing: if anything
//     fails, every slice goes back to how it was. A safety copy of this device's data can be downloaded first. Restored
//     records then upload through the usual queue, where every upload is a safe save by id (nothing in the cloud is deleted).
import { store } from '../../../shared/state/store.js';
import { migrateCatalog, products } from '../../products/services/catalog.js';
import { D } from '../../inventory/services/ledger.js';
import { pushLocalToSupabase } from '../../sync/services/pull.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { $ } from '../../../shared/dom.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { persistLocal, saveCatalog, saveCustomers, saveEvents, saveImgs, saveLogo, saveMoves, saveReturns, storage } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { objOr } from '../../../shared/utils/objects.js';
import { logger } from '../../../shared/logging/logger.js';

export const BACKUP_VERSION=5;
const SECRET=/(secret|token|password|passwd|api_?key|service_?role|private_?key)/i;
/* A copy without any field named like a secret (profile and settings never hold one; this makes sure) */
export function withoutSecrets(v){
  if(Array.isArray(v)) return v.map(withoutSecrets);
  if(!v||typeof v!=="object") return v;
  const o={}; Object.keys(v).forEach(k=>{ if(!SECRET.test(k)) o[k]=withoutSecrets(v[k]); }); return o;
}
const hashOf=text=>use("files").sha256Hex(new Blob([text]));
/* The shop's data as a backup object */
export async function buildBackup(){
  const days=Object.assign({},store.remoteDays,store.localDays);
  const data={profile:withoutSecrets(store.profile||null),settings:withoutSecrets(store.settings),catalog:store.catalog,images:store.imgs,days,moves:store.moves,
    returns:store.returnsMap,customers:store.customers,events:store.events||{},logo:store.logo||""};
  const body=JSON.stringify(data);
  return {app:"hangtag",version:BACKUP_VERSION,exportedAt:new Date().toISOString(),
    shop:{owner:store.authUser&&store.authUser.id||"",name:store.profile&&store.profile.shop_name||""},
    counts:{products:products().length,bills:D().sales.length,returns:Object.keys(store.returnsMap).length,moves:Object.keys(store.moves).length,
      customers:Object.keys(store.customers).length,events:Object.keys(store.events||{}).length},
    integrity:{alg:"SHA-256",hash:await hashOf(body)},data};
}
export async function downloadBackup(label){
  const b=await buildBackup();
  const ok=await use("files").saveFile(`hangtag-${label||"backup"}-${dayKey(Date.now())}.json`,JSON.stringify(b),"application/json");
  logBackup({type:label||"backup",outcome:ok?"downloaded":"cancelled",counts:b.counts});
  if(ok&&!label) toast("Backup downloaded.");
  return ok;
}
/* A file's contents (version 5: under data; older versions: at the top) and whether its SHA-256 matches.
   → { file, data, integrity: "ok" | "none" (older file) | "bad" } */
export async function readBackup(file){
  if(!file||file.app!=="hangtag") return {file,data:null,integrity:"none"};
  if(!(+file.version>=5)) return {file,data:file,integrity:"none"};
  const data=file.data&&typeof file.data==="object"?file.data:null;
  if(!data||!file.integrity||!file.integrity.hash) return {file,data,integrity:"bad"};
  return {file,data,integrity:(await hashOf(JSON.stringify(data)))===file.integrity.hash?"ok":"bad"};
}
const shopIsEmpty=()=>!products().length&&!D().sales.length&&!Object.keys(store.customers).length;
/* Check a backup before anything changes; returns what a restore would do, or { ok:false, errs }.
   data: the backup's contents (a version 5 file's data, or an older file itself) · file: the whole file (version, shop) */
export function inspectBackup(data,file){
  const f=file||data||{}, errs=[];
  if(!data||(f.app||data.app)!=="hangtag")return {ok:false,errs:["This file isn't a Hangtag backup."]};
  if(+f.version>BACKUP_VERSION)return {ok:false,errs:["This backup was made by a newer version of Hangtag. Update the app (reload it), then try again."]};
  const owner=f.shop&&f.shop.owner, me=store.authUser&&store.authUser.id;
  if(owner&&me&&owner!==me&&!shopIsEmpty())return {ok:false,errs:[`This backup is from another shop${f.shop.name?" ("+f.shop.name+")":""}. It can only be restored into an empty shop.`]};
  if(!data.days||typeof data.days!=="object")errs.push("The bills section is missing.");
  const mig=migrateCatalog(data.catalog&&Array.isArray(data.catalog.products)?data.catalog:{version:3,products:[]});
  const bprods=mig.cat.products||[];
  bprods.forEach((p,i)=>{if(!p||!p.id||!Array.isArray(p.variants))errs.push(`Product ${i+1} is damaged.`)});
  if(errs.length)return {ok:false,errs};
  const have=new Set(products().map(p=>p.id)),haveSales=new Set(D().sales.map(s=>s.id));
  let bills=0,newBills=0,skipped=0;
  Object.values(data.days).forEach(doc=>(doc&&Array.isArray(doc.sales)?doc.sales:[]).forEach(s=>{if(s&&s.id&&Array.isArray(s.items)){bills++;if(!haveSales.has(s.id))newBills++}else skipped++}));
  const bm=Object.assign({},objOr(data.moves,{}));mig.moves.forEach(m=>{if(!bm[m.id])bm[m.id]=m});
  const keep=(o,ok)=>{const r={};Object.entries(objOr(o,{})).forEach(([k,x])=>{if(ok(x))r[k]=x;else skipped++});return r};
  const moves=keep(bm,m=>m&&m.v), br=keep(data.returns,x=>x&&x.sale&&Array.isArray(x.items)), bc=keep(data.customers,c=>c&&c.name);
  const be=keep(data.events,e=>e&&e.id&&e.name&&e.start&&e.end);
  return {ok:true,data,file:f,cat:mig.cat,moves,returns:br,customers:bc,events:be,
    summary:{products:bprods.length,newProducts:bprods.filter(p=>!have.has(p.id)).length,variants:bprods.reduce((a,p)=>a+p.variants.length,0),
      bills,newBills,moves:Object.keys(moves).length,newMoves:Object.keys(moves).filter(k=>!store.moves[k]).length,
      returns:Object.keys(br).length,newReturns:Object.keys(br).filter(k=>!store.returnsMap[k]).length,
      customers:Object.keys(bc).length,newCustomers:Object.keys(bc).filter(k=>!store.customers[k]).length,
      events:Object.keys(be).length,newEvents:Object.keys(be).filter(k=>!(store.events||{})[k]).length,skipped,
      exportedAt:f.exportedAt||data.exportedAt||"",shop:f.shop&&f.shop.name||"",version:+f.version||0,fromOtherShop:!!(owner&&me&&owner!==me)}};
}
const SLICES=["catalog","imgs","moves","returnsMap","customers","events","localDays","logo"];
/* Every slice as it is now (a deep copy), to go back to if the restore fails */
const snapshot=()=>JSON.parse(JSON.stringify(Object.fromEntries(SLICES.map(k=>[k,store[k]]).concat([["dirty",[...store.dirty]]]))));
function putBack(s){
  SLICES.forEach(k=>{store[k]=s[k]}); store.dirty=new Set(s.dirty); store._d=null;
  saveAll();
}
/* Save every restored slice; false when this device's storage refused one */
function saveAll(){
  const r=[saveCatalog(),saveImgs(),saveMoves(),saveReturns(),saveCustomers(),saveEvents(),saveLogo(),persistLocal()];
  return r.every(x=>x!==false);
}
/* Add the backup's records this device doesn't have (replace: also products on both). Throws on a broken record. */
function mergeBackup(r,replace){
  const data=r.data, cur=products(), byId={}; cur.forEach((p,i)=>{byId[p.id]=i});
  const list=cur.slice(); r.cat.products.forEach(p=>{if(byId[p.id]==null)list.push(p);else if(replace)list[byId[p.id]]=p});
  store.catalog={version:3,example:false,products:list};
  if(data.images&&typeof data.images==="object")Object.keys(data.images).forEach(id=>{const src=data.images[id];if(typeof src==="string"&&src.indexOf("data:image/")===0&&(!store.imgs[id]||replace))store.imgs[id]=src});
  Object.entries(r.moves).forEach(([k,m])=>{if(!store.moves[k])store.moves[k]=m});
  Object.entries(r.returns).forEach(([k,x])=>{if(!store.returnsMap[k])store.returnsMap[k]=x});
  Object.entries(r.customers).forEach(([k,c])=>{if(!store.customers[k])store.customers[k]=c});
  if(!store.events) store.events={};
  Object.entries(r.events).forEach(([k,e])=>{if(!store.events[k])store.events[k]=e});
  if(!store.logo&&typeof data.logo==="string"&&data.logo.indexOf("data:image/")===0) store.logo=data.logo;
  let added=0;
  Object.keys(data.days||{}).forEach(id=>{
    const doc=data.days[id];if(!doc||!Array.isArray(doc.sales)||!/^[A-Za-z0-9_.-]+$/.test(id))return;
    let curDoc=store.localDays[id]||(store.remoteDays[id]?JSON.parse(JSON.stringify(store.remoteDays[id])):null);
    const good=doc.sales.filter(s=>s&&s.id&&Array.isArray(s.items));
    if(!curDoc){curDoc={...JSON.parse(JSON.stringify(doc)),sales:JSON.parse(JSON.stringify(good)),voids:Array.isArray(doc.voids)?doc.voids.slice():[]};store.localDays[id]=curDoc;store.dirty.add(id);added+=good.length;return}
    store.localDays[id]=curDoc;if(!curDoc.voids)curDoc.voids=[];
    const have=new Set(curDoc.sales.map(s=>s.id));let ch=false;
    good.forEach(s=>{if(!have.has(s.id)&&!D().saleById[s.id]){curDoc.sales.push(s);added++;ch=true}});
    (doc.voids||[]).forEach(v=>{if(!curDoc.voids.includes(v)){curDoc.voids.push(v);ch=true}});
    if(ch)store.dirty.add(id);
  });
  store._d=null;
  return added;
}
export async function applyRestore(){
  const r=store.restoreCheck;if(!r)return;
  const replace=!!($("#rsReplace")||{}).checked, safety=!!($("#rsSafety")||{}).checked;
  if(safety&&!shopIsEmpty()) await downloadBackup("before-restore");
  const before=snapshot();
  let added=0;
  try{
    added=mergeBackup(r,replace);
    if(!saveAll()) throw new Error("This device's storage is full.");
  }catch(e){
    logger.error("Restore failed, putting the data back:",e);
    putBack(before); store.restoreCheck=null; closeModal(); renderAll();
    logBackup({type:"restore",outcome:"failed",error:String(e&&e.message||e)});
    toast("Restore failed, so nothing was changed"+(e&&e.message?": "+e.message:"."));
    return false;
  }
  store.restoreCheck=null;closeModal();renderAll();
  logBackup({type:"restore",outcome:"restored",counts:{bills:added}});
  toast(`Backup restored — ${added} bill${added===1?"":"s"} added.`);
  pushLocalToSupabase();
  return true;
}
/* This device's record of backups and restores (the last 20) */
function logBackup(entry){
  try{ const log=storage.get("hangtag_backup_log",[]); storage.set("hangtag_backup_log",[{t:Date.now(),dev:store.dev,...entry},...(Array.isArray(log)?log:[])].slice(0,20)); }
  catch(e){ logger.warn("Backup log:",e); }
}

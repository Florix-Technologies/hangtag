// Applies live changes from the shop's other devices.
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { pullCatalogFromSupabase, pullCustomers, pullEvents, pullMoves, pullReturns, pullSettings } from './pull.js';
import { use } from '../../../shared/di/services.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { saveImgs, saveMoves } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { logger } from '../../../shared/logging/logger.js';

/* ---------- realtime handlers (payloads carry database rows; the cloud port's records.* turn them into app records) ---------- */

export async function onRemoteSaleEvent(payload){
  if(payload.eventType === "INSERT"){
    const s = payload.new;
    if(s && s.id && !D().saleById[s.id]){
      const saleObj = use("cloud").records.toSale(s, []);
      const d = dayKey(saleObj.t), devId = saleObj.dev || "sb", dayId = `${d}_${devId}_0`;
      if(!store.remoteDays[dayId]) store.remoteDays[dayId] = { date: d, dev: devId, chunk: 0, sales: [], voids: [] };
      store.remoteDays[dayId].sales.push(saleObj);
      if(s.is_void && !store.remoteDays[dayId].voids.includes(s.id)) store.remoteDays[dayId].voids.push(s.id);
      renderAll();
      try{
        mergeRemoteItems(s.id, await use("cloud").fetchSaleLineRows(s.id));
        // the bill, its lines and its payments are saved together, so they are all there by now
        const pays = await use("cloud").fetchSalePayments(s.id);
        if(pays.length){ saleObj.payments = pays; renderAll(); }
      }catch(e){ logger.warn("Could not fetch bill lines:", e); }
    }
  } else if(payload.eventType === "UPDATE"){
    const s = payload.new;
    if(s && s.id){
      let changed = false;
      Object.keys(store.remoteDays).forEach(k=>{
        const doc = store.remoteDays[k], ex = doc.sales.find(x=>x.id===s.id);
        if(ex){
          ex.void = s.is_void;
          if(s.is_void && !doc.voids.includes(s.id)) doc.voids.push(s.id);
          else if(!s.is_void){ const vi = doc.voids.indexOf(s.id); if(vi > -1) doc.voids.splice(vi, 1); }
          changed = true;
        }
      });
      if(changed) renderAll();
    }
  }
}
export function mergeRemoteItems(saleId, rows){
  let sale=null;
  Object.values(store.remoteDays).some(doc=>(sale=(doc.sales||[]).find(x=>x.id===saleId)));
  if(!sale || !rows.length) return;
  let changed=false;
  rows.forEach(r=>{ if(sale.items.some(i=>i.ln===r.line_no)) return; sale.items.push(use("cloud").records.toSaleLine(r)); changed=true; });
  if(changed){ sale.items.sort((a,b)=>a.ln-b.ln); renderAll(); }
}
export function onRemoteCatalogEvent(){
  clearTimeout(store.catPullT);
  store.catPullT = setTimeout(async ()=>{ await pullCatalogFromSupabase(true); renderAll(); }, 400);
}
export async function onRemoteImageEvent(payload){
  if(payload.eventType === "DELETE"){
    if(payload.old && payload.old.product_id && (!payload.old.owner_id || (store.authUser && payload.old.owner_id === store.authUser.id))){
      delete store.imgs[payload.old.product_id]; saveImgs(); renderAll();
    }
  } else if(payload.new && payload.new.product_id){
    store.imgs[payload.new.product_id] = payload.new.image_data; saveImgs(); renderAll();
  }
}
export function onRemoteMoveEvent(payload){
  if(payload.eventType === "DELETE"){ debouncePull("moves"); return; }
  const r = payload.new; if(!r || !r.id) return;
  store.moves[r.id] = use("cloud").records.toMove(r); saveMoves(); renderAll();
}
export const pullT = {};
export function debouncePull(what){
  clearTimeout(pullT[what]);
  pullT[what] = setTimeout(async ()=>{
    try{
      if(what==="returns") await pullReturns();
      else if(what==="customers") await pullCustomers();
      else if(what==="settings") await pullSettings();
      else if(what==="moves") await pullMoves();
      else if(what==="events") await pullEvents();
      renderAll();
    }catch(e){ logger.warn("Pull "+what+" failed:", e); }
  }, 500);
}

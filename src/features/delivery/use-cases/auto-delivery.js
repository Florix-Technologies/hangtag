// Sending the receipt by itself when a bill completes (spec 009): the shop turns each channel on in Settings, and the
// payment screen can turn it off for one sale. The jobs wait on this device (store.deliveryQueue, kept across restarts)
// until the app is online and the bill has uploaded — the server writes the message from the saved bill — and go
// through the "messageDelivery" port marked `auto`, so the server sends each bill at most once per channel however often
// this retries. Temporary failures are tried again (5 attempts within 30 minutes); a WhatsApp that fails falls back to
// SMS when SMS is on. Nothing is shown as sent unless the provider accepted it.
import { AUTO_OFF, autoDeliveryPlan, nextAttemptAt } from '../../../domain/invoices/delivery.js';
import { INVOICE_STATUS } from '../../../domain/invoices/invoice.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { invoiceFor } from '../../receipts/services/receipt-model.js';
import { messageDelivery } from '../repositories/delivery-service.js';
import { saveDeliveryQueue } from '../../../shared/state/persistence.js';
import { ERROR_CODES, userMessage } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';
import { uid } from '../../../shared/utils/ids.js';

const online=()=>!!store.sbClient&&store.sbStatus==="connected";
const listeners=new Set();
/* The bill view / payment screen redraw a bill's delivery line when its jobs change */
export const onDeliveryChange=f=>{listeners.add(f);return ()=>listeners.delete(f)};
const changed=sid=>listeners.forEach(f=>{try{f(sid)}catch(e){logger.warn(e)}});

export const autoSettings=()=>Object.assign({},AUTO_OFF,store.settings.autoSend||{});
export const autoOn=()=>Object.values(autoSettings()).some(Boolean);
/* The automatic sends of a bill, newest first */
export const autoJobs=sid=>store.deliveryQueue.filter(j=>j.saleId===sid).sort((a,b)=>b.t-a.t);
/* What would go out for this bill now ([{ channel, fallback? }]) */
export const autoPlanFor=sale=>autoDeliveryPlan(invoiceFor(sale),autoSettings(),store.channels);
/* The same for the customer on a bill still being paid for */
export function autoPlanForCustomer(c){
  if(!c||!c.name) return [];
  const cr=c.id&&store.customers[c.id]||{};
  return autoDeliveryPlan({status:INVOICE_STATUS.VALID,buyer:{name:c.name,mobile:cr.phone||c.phone||"",email:cr.email||""}},autoSettings(),store.channels);
}

/* Queues the receipt of a bill that has just completed. Each bill and channel is queued once. → the new jobs */
export function queueAutoDelivery(sale){
  const plan=autoPlanFor(sale), now=Date.now(), jobs=[];
  plan.forEach(p=>{
    if(store.deliveryQueue.some(j=>j.saleId===sale.id&&j.channel===p.channel)) return;
    jobs.push({id:uid(),saleId:sale.id,channel:p.channel,...(p.fallback?{fallback:p.fallback}:{}),status:"queued",attempts:0,first:now,nextAt:now,t:now});
  });
  if(!jobs.length) return jobs;
  store.deliveryQueue.push(...jobs); saveDeliveryQueue(); changed(sale.id);
  setTimeout(processDeliveryQueue,1200);
  return jobs;
}
/* Temporary: worth trying again later. Everything else (no contact, cancelled bill, channel not set up) is final. */
function temporary(e){
  const why=e&&e.details&&e.details.error;
  if(why==="rate_limited"||why==="not_found"||why==="server_error"||why==="busy") return true;
  return !e||[ERROR_CODES.NETWORK,ERROR_CODES.DELIVERY,ERROR_CODES.AUTH,ERROR_CODES.UNKNOWN].includes(e.code);
}
let running=null;
/* Sends every job that is due. Safe to call often: one run at a time. */
export function processDeliveryQueue(){
  if(!running) running=run().finally(()=>{running=null});
  return running;
}
async function run(){
  const now=Date.now(), touched=new Set();
  for(const j of store.deliveryQueue){
    if(j.status!=="queued"||(j.nextAt||0)>now) continue;
    const s=D().saleById[j.saleId];
    if(!s||s.void){ Object.assign(j,{status:"skipped",error:s?"The bill was cancelled.":"The bill isn't on this device.",t:Date.now()}); touched.add(j.saleId); continue; }
    if(!online()){ if(j.wait!=="offline"){ j.wait="offline"; touched.add(j.saleId); } continue; }
    const uploading=store.sbOfflineQueue.some(q=>(q.type==="sale"&&q.sale&&q.sale.id===j.saleId)||(q.type==="cust"&&s.cust&&q.id===s.cust.id));
    if(uploading){ if(j.wait!=="upload"){ j.wait="upload"; touched.add(j.saleId); } continue; }
    Object.assign(j,{status:"sending",wait:"",attempts:(j.attempts||0)+1}); touched.add(j.saleId); changed(j.saleId);
    try{
      const r=await messageDelivery().send({channel:j.channel,saleId:j.saleId,auto:true});
      Object.assign(j,{status:r.status==="delivered"?"delivered":"sent",to:r.to,providerId:r.id,error:"",t:Date.now()});
      // the server's own record of it, for the bill's history
      store.deliveries[j.saleId]=[{channel:j.channel,to:r.to,status:j.status,provider:r.provider,providerId:r.id,mode:"auto",t:j.t},...(store.deliveries[j.saleId]||[]).filter(e=>e.status!=="sending")];
    }catch(e){
      const msg=userMessage(e,"The receipt wasn't sent."), again=temporary(e)&&!(j.channel==="whatsapp"&&j.fallback&&e.code===ERROR_CODES.DELIVERY)?nextAttemptAt(j,Date.now()):null;
      if(again) Object.assign(j,{status:"queued",nextAt:again,error:msg});
      else{
        Object.assign(j,{status:"failed",error:msg,t:Date.now()});
        if(j.fallback&&!store.deliveryQueue.some(x=>x.saleId===j.saleId&&x.channel===j.fallback)){
          const t=Date.now();
          store.deliveryQueue.push({id:uid(),saleId:j.saleId,channel:j.fallback,status:"queued",attempts:0,first:t,nextAt:t,t,after:j.channel});
        }
      }
      logger.warn("Automatic receipt:",e);
    }
    saveDeliveryQueue(); changed(j.saleId);
  }
  // finished jobs are kept two days (the bill shows what happened), then dropped
  const keep=store.deliveryQueue.filter(j=>j.status==="queued"||j.status==="sending"||Date.now()-j.t<2*864e5);
  if(keep.length!==store.deliveryQueue.length) store.deliveryQueue=keep;
  saveDeliveryQueue();
  touched.forEach(changed);
  // a fallback just queued goes out in the same run
  if(store.deliveryQueue.some(j=>j.status==="queued"&&(j.nextAt||0)<=Date.now()&&!j.wait&&j.attempts===0)&&online()) setTimeout(processDeliveryQueue,500);
}
/* Registered once at start-up (app/main.js): a send cut off by a closed app is tried again (the server makes sure it
   goes once), and due retries run while the app is open */
export function installAutoDelivery(){
  store.deliveryQueue.forEach(j=>{ if(j.status==="sending") j.status="queued"; });
  setInterval(()=>{ if(store.deliveryQueue.some(j=>j.status==="queued")) processDeliveryQueue(); },15000);
  window.addEventListener("online",()=>setTimeout(processDeliveryQueue,3000));
}

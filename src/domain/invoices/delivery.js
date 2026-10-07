// Sending a bill to the customer by email, WhatsApp or SMS: who it can go to, and when it can't be sent. The address
// always comes from the bill's customer (the customer list), never typed in at send time. Pure.
import { isValidInvoice } from './invoice.js';
import { validEmail } from '../../shared/validation/email.js';

export const CHANNELS=["email","whatsapp","sms"];
export const CHANNEL_LABELS={email:"Email",whatsapp:"WhatsApp",sms:"SMS"};

/* An Indian mobile number as +91XXXXXXXXXX (10 digits starting 6-9, with or without +91 / 0), or "" */
export function mobileE164(phone){
  let d=String(phone||"").replace(/\D/g,"");
  if(d.length===12&&d.startsWith("91")) d=d.slice(2); else if(d.length===11&&d.startsWith("0")) d=d.slice(1);
  return /^[6-9]\d{9}$/.test(d)?"+91"+d:"";
}
/* Where a bill would go on a channel: { to } or { error } (a reason written for the shop) */
export function deliveryTarget(inv,channel){
  if(!CHANNELS.includes(channel)) return {error:"Choose email, WhatsApp or SMS."};
  if(!isValidInvoice(inv)) return {error:"A cancelled bill can't be sent."};
  if(!inv.buyer) return {error:"This is a walk-in bill. Add a customer to a bill to send it to them."};
  if(channel==="email"){
    const e=String(inv.buyer.email||"").trim();
    return e&&validEmail(e)?{to:e}:{error:`${inv.buyer.name} has no email address. Add one in Customers to email the bill.`};
  }
  const m=mobileE164(inv.buyer.mobile);
  return m?{to:m}:{error:`${inv.buyer.name} has no mobile number${inv.buyer.mobile?" that can get messages":""} in Customers. Add one there to send by ${CHANNEL_LABELS[channel]}.`};
}

/* ---------- sending automatically when a bill completes ---------- */
export const AUTO_OFF={whatsapp:false,sms:false,email:false};
/* Which channels a completed bill goes out on by itself (shop settings `auto`, and `ready`: what the server can send, or
   null when unknown): WhatsApp when on and the customer has a mobile — with SMS as its fallback when SMS is on too; SMS
   when WhatsApp is off; email when on and the customer has an email. → [{ channel, fallback? }] */
export function autoDeliveryPlan(inv,auto,ready){
  if(!isValidInvoice(inv)||!inv.buyer) return [];
  const on=c=>!!(auto&&auto[c])&&!(ready&&ready[c]===false), plan=[];
  if(!deliveryTarget(inv,"sms").error){
    if(on("whatsapp")) plan.push(on("sms")?{channel:"whatsapp",fallback:"sms"}:{channel:"whatsapp"});
    else if(on("sms")) plan.push({channel:"sms"});
  }
  if(on("email")&&!deliveryTarget(inv,"email").error) plan.push({channel:"email"});
  return plan;
}
/* Temporary failures are tried again: at most 5 attempts, within 30 minutes of the first. → when to try next, or null */
export const RETRY_DELAYS=[60e3,2*60e3,5*60e3,10*60e3];
export const MAX_ATTEMPTS=5, RETRY_WINDOW=30*60e3;
export function nextAttemptAt(job,now){
  if((job.attempts||0)>=MAX_ATTEMPTS) return null;
  const at=now+RETRY_DELAYS[Math.min(Math.max(0,(job.attempts||1)-1),RETRY_DELAYS.length-1)];
  return at-(job.first==null?now:job.first)>RETRY_WINDOW?null:at;
}

/* ---------- where a bill's receipt is: Queued, Sent, Delivered or Failed ---------- */
export const RECEIPT_STATES=Object.freeze({queued:"Queued",sent:"Sent",delivered:"Delivered",failed:"Failed"});
const RANK={failed:1,queued:2,sent:3,delivered:4};
/* A record's status (an automatic send on this device, or the server's record of a send) as one of the four, or null when
   it says nothing about the customer getting it (WhatsApp opened on this device, a send skipped for a cancelled bill) */
export function receiptStateOf(status){
  if(status==="delivered"||status==="read") return "delivered";
  if(status==="sent") return "sent";
  if(status==="failed") return "failed";
  if(status==="queued"||status==="sending"||status==="pending") return "queued";
  return null;
}
/* jobs: this device's automatic sends of the bill ({ channel, status, wait, to, error, attempts, t, after }); history: the
   server's records and this device's manual sends ({ channel, status, to, error, t }) → { channels: [{ channel, state, to,
   error, at, wait }] (one per channel: its latest record, the server's when it is as new or newer), state: the bill's — the
   best any channel reached (delivered, then sent, queued, failed: a WhatsApp that failed with the SMS sent is "sent"), or ""
   when nothing was sent or queued } */
export function receiptStatus({jobs=[],history=[]}={}){
  const latest=(list,ch)=>(list||[]).filter(r=>r&&r.channel===ch&&receiptStateOf(r.status)).sort((a,b)=>(+b.t||0)-(+a.t||0))[0]||null;
  const channels=[];
  CHANNELS.forEach(ch=>{
    const s=latest(history,ch), j=latest(jobs,ch);
    // the server's record of a send is the outcome (it also hears "delivered" from the provider) — unless this device
    // queued the channel again after it (a retry)
    const use=s&&(!j||(+s.t||0)>=(+(j.first||j.t)||0))?s:j;
    if(!use) return;
    channels.push({channel:ch,state:receiptStateOf(use.status),to:use.to||"",error:use.error||"",at:+use.t||0,...(use===j&&j.wait?{wait:j.wait}:{})});
  });
  const best=channels.reduce((b,c)=>!b||RANK[c.state]>RANK[b]?c.state:b,"");
  return {channels,state:best};
}

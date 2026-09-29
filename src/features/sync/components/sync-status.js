// Sync status pill.
import { store } from '../../../shared/state/store.js';
import { $ } from '../../../shared/dom.js';
import { agoText } from '../../../shared/formatting/dates.js';
import { storage } from '../../../shared/state/persistence.js';

export function renderSync(){
  const el=$("#sync"),tx=el.querySelector("span"),{cls,txt,tip}=syncSummary();
  el.className=cls; tx.textContent=txt; el.title=tip; el.setAttribute("aria-label",tip);
}
/* Where this device stands with the cloud: { cls (sync ok | wait | off), txt (short), tip (a sentence), pending } — the
   sync pill and Home show it */
export function syncSummary(){
  const n=store.sbOfflineQueue.length, stuck=store.sbOfflineQueue.find(q=>(q.tries||0)>=3), rv=(store.syncReview||[]).length;
  let cls="sync",txt="Connecting…",tip="";
  if(store.sbStatus === "connected"){
    if(rv){ cls+=" off"; txt="Sync problem · "+rv; tip=rv+" change"+(rv===1?"":"s")+" the database refused. Tap to review them."; }
    else if(stuck){ cls+=" off"; txt="Sync problem"; tip="Some changes couldn't upload: "+(stuck.err||"unknown error")+". They're kept on this device and will retry. Tap for details."; }
    else if(n || store.syncing){ cls+=" wait"; txt=n?"Syncing "+n+"…":"Syncing…"; tip=n?n+" change"+(n===1?"":"s")+" uploading to the cloud.":"Checking for changes from your other devices."; }
    else { cls+=" ok"; txt="Synced"+(store.lastSyncAt?" · "+agoText(store.lastSyncAt).replace(" ago",""):""); tip="Cloud synced"+(store.lastSyncAt?" · last synced "+agoText(store.lastSyncAt):"")+". Your devices stay in step."; }
  } else if(store.sbStatus === "connecting"){ cls+=" wait"; txt="Connecting…"; tip="Connecting to the cloud…"; }
  else if(store.sbStatus === "update"){ cls+=" off"; txt="Database update needed"; tip="Run the latest schema.sql in the Supabase SQL Editor. Until then everything is saved on this device"+(n?" ("+n+" change"+(n===1?"":"s")+" waiting)":"")+"."; }
  else if(store.sbStatus === "error"){ cls+=" off"; txt=n?"Offline · "+n+" pending":"Cloud error"; tip="Couldn't reach the cloud"+(store.sbErrorText?": "+store.sbErrorText:"")+". Everything is saved on this device and uploads when it's back."; }
  else if(store.authUser || storage.get("hangtag_auth_email","")){ cls+=" off"; txt=n?"Offline · "+n+" pending":"Offline"; tip=n?n+" change"+(n===1?"":"s")+" saved on this device, waiting to upload.":"Working offline. Everything is saved on this device."; }
  else { cls+=" off"; txt="Local Storage"; tip="Running locally in browser storage."; }
  return {cls,txt,tip,pending:n,review:rv};
}

/* Registered once at start-up (app/main.js). */
export function installSyncStatusTimer(){
  setInterval(()=>{ if(store.sbStatus==="connected") renderSync(); }, 30000);
}

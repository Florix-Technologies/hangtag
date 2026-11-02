// Outbound webhooks (Settings → Advanced → Integrations): the shop's owner only. Endpoints live in the cloud; the signing
// secret is made by the database and shown once (when made or replaced) — it is never kept in the app. Deliveries, retries
// and their log are the database's and the webhook-dispatch Edge Function's.
import { MAX_ENDPOINTS, checkEvents, checkUrl } from '../../../domain/shop/webhooks.js';
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { isMember } from '../../shop/services/access.js';

const online = () => !!store.sbClient && store.sbStatus === "connected";
const guard = () => isMember() ? { error: "Only the shop's owner can set up integrations." } : !online() ? { error: "Integrations are set up online. Connect, then try again." } : null;
const fail = e => ({ error: e && e.message ? e.message : "That didn't work. Try again." });
export async function listWebhooks(){
  const no = guard(); if(no) return no;
  try{ const cloud = use("cloud"); const [endpoints, deliveries] = await Promise.all([cloud.webhookEndpoints(), cloud.webhookDeliveries(30)]); return { endpoints, deliveries }; }catch(e){ return fail(e); }
}
/* → { endpoint, secret } (the secret to copy now: it isn't shown again) or { error, field } */
export async function addWebhook({ url, events, description }, existing){
  const no = guard(); if(no) return no;
  if((existing || []).length >= MAX_ENDPOINTS) return { error: `A shop can have up to ${MAX_ENDPOINTS} webhooks.` };
  const u = checkUrl(url); if(u.error) return { ...u, field: "url" };
  const ev = checkEvents(events); if(ev.error) return { ...ev, field: "events" };
  try{ return await use("cloud").webhookCreate(u.url, ev.events, String(description || "").trim().slice(0, 80)); }catch(e){ return fail(e); }
}
export async function setWebhookActive(id, active){
  const no = guard(); if(no) return no;
  try{ return { endpoint: await use("cloud").webhookUpdate(id, { active }) }; }catch(e){ return fail(e); }
}
export async function rotateWebhookSecret(id){
  const no = guard(); if(no) return no;
  try{ return { secret: await use("cloud").webhookRotate(id) }; }catch(e){ return fail(e); }
}
export async function removeWebhook(id){
  const no = guard(); if(no) return no;
  try{ await use("cloud").webhookDelete(id); return { ok: true }; }catch(e){ return fail(e); }
}
export async function testWebhook(id){
  const no = guard(); if(no) return no;
  try{ await use("cloud").webhookTest(id); return { ok: true }; }catch(e){ return fail(e); }
}

// Settings → Advanced → Integrations (the owner's): a short list of webhook addresses, their events and the last
// deliveries. Not a developer platform: add, pause, test, replace the secret, remove.
import { DELIVERY_LABELS, EVENT_LABELS, WEBHOOK_EVENTS } from '../../../domain/shop/webhooks.js';
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { isMember } from '../../shop/services/access.js';
import { addWebhook, listWebhooks, removeWebhook, rotateWebhookSecret, setWebhookActive, testWebhook } from '../use-cases/webhooks.js';
import { bizError, bizSheet, chip } from './biz-sheet.js';

const V = () => store.bizView || {};
const TONE = { delivered: "ok", failed: "bad", pending: "warn", sending: "info" };
export const integrationsSettingsHTML = () => isMember() ? "" : `<div class="setpart"><h5 class="subh">Integrations</h5><p class="note" style="margin:0">Send bills, payments, orders and stock changes to your own software (webhooks).</p>
  <div class="setactions"><button type="button" class="btn sm" data-whopen>Webhooks</button></div></div>`;
export async function openWebhooks(){
  store.bizView = { kind: "wh", loading: true, endpoints: [], deliveries: [], form: null, secret: "", err: "" };
  renderWebhooks();
  const r = await listWebhooks(); if(V().kind !== "wh") return;
  Object.assign(store.bizView, r.error ? { err: r.error } : r, { loading: false }); renderWebhooks();
}
function renderWebhooks(){
  const F = V();
  if(F.form){
    bizSheet({ label: "Add webhook", body: `<label class="f full">Address<input data-whf="url" value="${esc(F.form.url || "")}" placeholder="https://example.com/hangtag" inputmode="url"></label>
      <div class="whevents">${WEBHOOK_EVENTS.map(e => `<label class="chk"><input type="checkbox" data-whev="${esc(e)}"${F.form.events.includes(e) ? " checked" : ""}> ${esc(EVENT_LABELS[e])}</label>`).join("")}</div>`,
      foot: `<button type="button" class="btn sm" data-whback>Back</button><button type="button" class="btn sm primary" data-whadd>Add</button>` });
    return;
  }
  const eps = F.endpoints.map(e => `<div class="disc-row"><span><b>${esc(e.url)}</b><small>${e.events.map(x => esc(EVENT_LABELS[x] || x)).join(", ")}</small></span>
    <span class="oc-acts">${chip(e.active ? "On" : "Paused", e.active ? "ok" : "muted")}<button type="button" class="btn xs" data-whtest="${esc(e.id)}">Test</button><button type="button" class="btn xs" data-whtoggle="${esc(e.id)}">${e.active ? "Pause" : "Resume"}</button><button type="button" class="btn xs" data-whrotate="${esc(e.id)}">New secret</button><button type="button" class="btn xs danger" data-whdel="${esc(e.id)}">Remove</button></span></div>`).join("");
  const log = F.deliveries.slice(0, 12).map(d => `<div class="disc-row"><span><b>${esc(EVENT_LABELS[d.type] || d.type || "Event")}</b><small>${d.attempts} attempt${d.attempts === 1 ? "" : "s"}${d.lastStatus ? ` · HTTP ${d.lastStatus}` : ""}${d.lastError ? ` · ${esc(d.lastError)}` : ""}</small></span>${chip(DELIVERY_LABELS[d.status] || d.status, TONE[d.status])}</div>`).join("");
  bizSheet({ label: "Webhooks", sub: "Each request is signed (X-Hangtag-Signature: HMAC-SHA256 of timestamp.body) and retried until delivered.",
    body: `${F.secret ? `<div class="biznote ok">Copy this signing secret now — it isn't shown again:<div class="whsecret">${esc(F.secret)}</div></div>` : ""}${F.loading ? `<p class="muted">Loading…</p>` : eps || `<p class="muted">No webhooks yet.</p>`}
      ${log ? `<h5 class="subh">Last deliveries</h5>${log}` : ""}`,
    foot: `<button type="button" class="btn sm" data-biz="close">Done</button><button type="button" class="btn sm primary" data-whnew>Add webhook</button>` });
}
export function webhooksClick(t){
  if(t.closest("[data-whopen]")){ openWebhooks(); return true; }
  const F = V(); if(F.kind !== "wh") return false;
  if(t.closest("[data-whnew]")){ F.form = { url: "", events: ["sale.completed"] }; F.secret = ""; renderWebhooks(); return true; }
  if(t.closest("[data-whback]")){ F.form = null; renderWebhooks(); return true; }
  const ev = t.closest("[data-whev]"); if(ev && F.form){ const e = ev.dataset.whev; F.form.events = ev.checked ? [...new Set([...F.form.events, e])] : F.form.events.filter(x => x !== e); return true; }
  const after = async (p, msg) => { const r = await p; if(r && r.error){ bizError(r.error); return; } if(msg) toast(msg); const l = await listWebhooks(); if(V() === F && !l.error){ Object.assign(F, l); renderWebhooks(); } return r; };
  if(t.closest("[data-whadd]") && F.form){ addWebhook(F.form, F.endpoints).then(r => { if(r.error){ bizError(r.error); return; } F.form = null; F.secret = r.secret; after(Promise.resolve(r), "Webhook added."); }); return true; }
  const tt = t.closest("[data-whtest]"); if(tt){ after(testWebhook(tt.dataset.whtest), "Test event queued: it goes out with the next delivery run."); return true; }
  const tg = t.closest("[data-whtoggle]"); if(tg){ const e = F.endpoints.find(x => x.id === tg.dataset.whtoggle); if(e) after(setWebhookActive(e.id, !e.active)); return true; }
  const ro = t.closest("[data-whrotate]"); if(ro){ rotateWebhookSecret(ro.dataset.whrotate).then(r => { if(r.error){ bizError(r.error); return; } F.secret = r.secret; renderWebhooks(); }); return true; }
  const dl = t.closest("[data-whdel]"); if(dl){ if(!dl.dataset.confirm){ dl.dataset.confirm = "1"; dl.textContent = "Tap again"; return true; } after(removeWebhook(dl.dataset.whdel), "Webhook removed."); return true; }
  return false;
}
export function webhooksInput(t){
  const F = V(); if(F.kind !== "wh" || !F.form || !t.matches("[data-whf]")) return false;
  F.form[t.dataset.whf] = t.value; return true;
}

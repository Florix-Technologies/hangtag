// Settings → Capabilities: what this shop uses, grouped and recommended for its type of business (human names, a line of
// help each). Only decides which screens, fields and switches the app shows; what each person may do stays in Roles &
// permissions. Saved with the shop's synced settings (use-cases/save-capabilities.js).
import { CAPABILITIES, CAP_KEYS, CAP_LABELS, businessLabel, capSections, defaultCaps } from '../../../domain/shop/capabilities.js';
import { shopCaps, shopType } from '../services/shop-caps.js';
import { can } from '../services/access.js';
import { saveCapabilities } from '../use-cases/save-capabilities.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { toast } from '../../../shared/components/toast.js';
import { $, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';

function capRow(c, caps, edit){
  const off = !!(c.needs && !caps[c.needs]);
  return `<label class="cap${off ? " dis" : ""}"><input type="checkbox" name="${esc(c.key)}" data-cap="${esc(c.key)}"${caps[c.key] ? " checked" : ""}${!edit || off ? " disabled" : ""}>
    <span><b>${esc(c.label)}</b><small>${esc(c.help)}${c.needs ? " Needs " + esc(CAP_LABELS[c.needs]) + "." : ""}</small></span></label>`;
}
export function capabilitiesHTML(){
  const type = shopType(), caps = shopCaps(), edit = can("manage_settings");
  return `<form id="capsForm" class="authform" novalidate>
    <p class="note secsub">Switch on what your shop uses and Hangtag shows the screens and fields for it; the rest stays out of the way. The recommended set for ${esc(businessLabel(type))} was switched on when the shop was set up. Who may do what is set in Roles &amp; permissions.</p>
    ${capSections(type, caps).map(g => `<details class="capgrp" data-capgrp="${esc(g.key)}"${g.open ? " open" : ""}><summary>${esc(g.label)}</summary>${g.caps.map(c => capRow(c, caps, edit)).join("")}</details>`).join("")}
    <p id="capsErr" class="autherr" role="alert" hidden></p>
    ${edit ? `<div class="setactions"><button class="btn sm primary" type="submit">Save capabilities</button><button class="btn sm" type="button" data-capsrec>Use the recommended set</button></div>` : ""}</form>`;
}
/* The form's switches as { uses_x: true|false } */
export function readCapsForm(form){
  const out = {};
  CAP_KEYS.forEach(k => { const el = form.querySelector(`[data-cap="${k}"]`); if(el) out[k] = !!el.checked && !el.disabled; });
  return out;
}
/* A switch another one builds on: those follow it (off and greyed while it is off) */
export function syncCapDeps(form){
  CAPABILITIES.forEach(c => {
    if(!c.needs) return;
    const el = form.querySelector(`[data-cap="${c.key}"]`), base = form.querySelector(`[data-cap="${c.needs}"]`);
    if(!el || !base) return;
    const off = !base.checked || base.disabled;
    el.disabled = off || !can("manage_settings"); if(off) el.checked = false;
    const row = el.closest(".cap"); if(row) row.classList.toggle("dis", off);
  });
}
function redraw(){ const f = $("#capsForm"); if(f) f.outerHTML = capabilitiesHTML(); }
function saved(r){
  const err = $("#capsErr");
  if(r.error){ if(err){ err.textContent = r.error; err.hidden = false; } return; }
  if(err) err.hidden = true;
  renderSync(); flushSbQueue(); renderAll(); redraw();
  toast("Capabilities saved.");
}
export function onCapsSubmit(form){ saved(saveCapabilities(readCapsForm(form))); }
export function useRecommendedCaps(){ saved(saveCapabilities(defaultCaps(shopType()))); }

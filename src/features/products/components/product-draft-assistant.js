// Optional smart product entry: description -> validated draft -> existing product editor. Saving remains a separate,
// explicit tap in the normal editor; this component never imports or calls the product save use case.
import { createProductDraftAssistant } from '../../../domain/catalog/product-draft-assistant.js';
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { closeModal } from '../../../shared/components/modal.js';
import { refuse } from '../../shop/services/access.js';
import { edCombos, openEditor, renderEditor } from './product-editor.js';

let state = null;
const assistant = createProductDraftAssistant();

function previewHTML(result){
  if(!result) return '';
  if(result.error) return `<p class="autherr" role="alert">${esc(result.error)}</p><p class="note">Manual product creation is still available from the Products page.</p>`;
  const d = result.draft;
  return `<div class="draft-preview"><span class="btag">Draft · review required</span><h4>${esc(d.name)}</h4><dl><div><dt>GST</dt><dd>${d.gst == null ? 'Not set' : esc(d.gst) + '%'}</dd></div>${d.variants.map(v => `<div><dt>${esc(v.label || 'Selling price')}</dt><dd>₹${Number(v.price).toLocaleString('en-IN')}</dd></div>`).join('')}</dl>${(result.warnings || []).map(w => `<p class="note">${esc(w)}</p>`).join('')}<button type="button" class="btn primary gbtn" data-product-draft-review>Review in product editor</button></div>`;
}

function render(){
  if(!state) return;
  $('#modalHost').innerHTML = `<div class="scrim" data-modal-scrim data-product-draft-modal><div class="sheet product-draft-sheet" role="dialog" aria-modal="true" aria-labelledby="draftTitle"><div class="sh-head"><div class="sh-t"><h3 id="draftTitle">Draft a product</h3><p>Describe it naturally. Nothing is saved until you review the normal product form and tap Add product.</p></div><button class="iconbtn" type="button" data-product-draft-close aria-label="Close">×</button></div><form id="productDraftForm"><label class="f"><span class="lab">Product description</span><textarea id="productDraftText" rows="4" maxlength="500" placeholder="Create Samsung A56, 256GB, ₹42999, 512GB ₹47999, GST 18%">${esc(state.text)}</textarea></label><button class="btn primary" type="submit"${state.busy ? ' disabled' : ''}>${state.busy ? 'Preparing…' : 'Prepare draft'}</button></form>${previewHTML(state.result)}</div></div>`;
}

export function openProductDraftAssistant(){
  if(refuse('manage_products', 'add products')) return;
  state = { text: '', busy: false, result: null }; render();
  const box = $('#productDraftText'); if(box) box.focus();
}

async function prepare(){
  if(!state) return;
  const active = state, box = $('#productDraftText'); active.text = box ? box.value : active.text;
  active.busy = true; active.result = null; render();
  const result = await assistant.prepare(active.text);
  if(state !== active) return;
  active.result = result; active.busy = false; render();
}

export function resetProductDraftAssistant(){ state = null; }

export function applyAssistedDraft(draft){
  if(!draft || refuse('manage_products', 'add products')) return false;
  openEditor(null); const e = store.editor; if(!e) return false;
  e.name = draft.name; e.price = String(draft.price); e.gst = draft.gst == null ? '' : String(draft.gst);
  if(draft.optionName && draft.variants.some(v => v.label)){
    e.hasOpts = true; e.opts = [{ n: draft.optionName, v: draft.variants.map(v => v.label) }]; e.cells = {};
    edCombos().forEach(row => { const v = draft.variants.find(x => x.label === row.o[0]); if(v) row.cell.price = String(v.price); });
  }
  state = null; renderEditor();
  return true;
}

let installed = false;
export function installProductDraftEvents(){
  if(installed) return; installed = true;
  document.addEventListener('click', event => {
    const t = event.target;
    if(t && t.closest && t.closest('[data-product-draft]')){ event.preventDefault(); openProductDraftAssistant(); return; }
    if(t && t.matches && t.matches('[data-product-draft-modal]')){ resetProductDraftAssistant(); return; }
    if(t && t.closest && t.closest('[data-product-draft-close]')){ state = null; closeModal(); return; }
    if(t && t.closest && t.closest('[data-product-draft-review]') && state && state.result && state.result.draft){ applyAssistedDraft(state.result.draft); }
  });
  document.addEventListener('submit', event => {
    if(!event.target || event.target.id !== 'productDraftForm') return;
    event.preventDefault(); prepare();
  });
}

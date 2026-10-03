// Optional microphone input for the existing product search boxes. The transcript is dispatched as an ordinary input
// event, so barcode scanning and the established search index remain unchanged.
import { use } from '../../../shared/di/services.js';
import { $$, esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';

const voice = () => use('voiceInput');
export const voiceSearchAvailable = () => { try{ return voice().available(); }catch{ return false; } };

export function voiceSearchButtonHTML(target, label = 'Search by voice'){
  return voiceSearchAvailable() ? `<button type="button" class="btn voicebtn" data-voice-search="${esc(target)}" aria-label="${esc(label)}" title="${esc(label)}"><span aria-hidden="true">🎙</span><span class="voice-label">Voice</span></button>` : '';
}

export async function startVoiceSearch(target){
  const input = document.getElementById(target);
  if(!input){ toast('Open a product search first.'); return { error: 'Search field unavailable.' }; }
  const buttons = $$(`[data-voice-search="${target}"]`); buttons.forEach(b => { b.disabled = true; b.classList.add('listening'); b.setAttribute('aria-label', 'Listening…'); });
  try{
    const transcript = String(await voice().listen({ lang: 'en-IN' }) || '').trim();
    if(!transcript) throw new Error('No words were heard. Try again or type your search.');
    input.value = transcript; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    return { transcript };
  }catch(error){ const message = error && error.message || 'Voice search is unavailable. Type your search instead.'; toast(message); return { error: message }; }
  finally{ buttons.forEach(b => { b.disabled = false; b.classList.remove('listening'); b.setAttribute('aria-label', 'Search by voice'); }); }
}

let installed = false;
export function installVoiceSearch(){
  if(installed) return; installed = true;
  $$('[data-voice-search]').forEach(b => { b.hidden = !voiceSearchAvailable(); });
  document.addEventListener('click', event => {
    const b = event.target && event.target.closest && event.target.closest('[data-voice-search]');
    if(!b) return; event.preventDefault(); startVoiceSearch(b.dataset.voiceSearch);
  });
}

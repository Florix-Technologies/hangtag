// Voice search for the product search boxes (Sell, Products): the browser's own speech recognition ("voiceInput" port,
// infrastructure/browser/browser-speech.js), no paid service. Tap the mic: it asks for the microphone the first time,
// shows that it is listening and what it hears, and puts the words in the search box, which searches by itself. Tap again
// (or Stop, or Esc) to stop. When the browser can't do it, or the microphone is blocked, it says why and what to do;
// typing and barcode scanning always keep working.
import { use } from '../../../shared/di/services.js';
import { $$, esc } from '../../../shared/dom.js';
import { UI_ICON } from '../../../shared/ui/kit.js';

const voice = () => use('voiceInput');
const tryVoice = fn => { try{ return fn(voice()); }catch{ return undefined; } };
export const voiceSearchAvailable = () => !!tryVoice(v => v.available());
const voiceSecure = () => tryVoice(v => typeof v.secure === 'function' ? v.secure() : true) !== false;

export function voiceSearchButtonHTML(target, label = 'Search by voice'){
  return `<button type="button" class="sb-ic voicebtn${voiceSearchAvailable() && voiceSecure() ? "" : " unsupported"}" data-voice-search="${esc(target)}" aria-label="${esc(label)}" title="${esc(label)}">${UI_ICON.mic}</button>`;
}

/* The line under a search box that says what voice search is doing */
function statusEl(target){
  let el = document.getElementById("vs-" + target);
  if(!el){
    const input = document.getElementById(target), box = input && (input.closest(".search") || input);
    if(!box) return null;
    el = document.createElement("div"); el.id = "vs-" + target; el.className = "voicestatus"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite"); el.hidden = true;
    (box.closest(".sellbar,.ptools") || box).after(el);
  }
  return el;
}
let hideT = 0;
function show(target, kind, html, ms){
  const el = statusEl(target); if(!el) return;
  clearTimeout(hideT);
  el.className = "voicestatus" + (kind ? " " + kind : ""); el.innerHTML = html; el.hidden = !html;
  if(ms) hideT = setTimeout(() => { el.hidden = true; }, ms);
}
const again = target => `<button type="button" class="btn sm" data-voice-search="${esc(target)}">Try again</button>`;
const WHY = {
  unsupported: () => "Voice search isn't available in this browser. It works in Chrome on Android and on computers, Edge and Safari. Type or scan instead.",
  insecure: () => "Voice search needs the app opened over https (a secure address). Type or scan instead.",
  denied: () => "The microphone is blocked for this app. Allow it in the browser's site settings (the icon next to the address), then try again.",
  "no-mic": () => "No microphone was found. Connect one, or type or scan instead.",
  "no-speech": () => "Didn't catch that. Tap the mic and say a product name, size or colour.",
  network: () => "Voice search needs an internet connection in this browser. Type or scan instead.",
  failed: () => "Voice search couldn't hear that. Try again, or type your search.",
};
let listening = "";
function setButtons(target, on){
  $$(`[data-voice-search="${target}"]`).forEach(b => { b.classList.toggle("listening", on); b.setAttribute("aria-pressed", String(on)); b.setAttribute("aria-label", on ? "Stop listening" : "Search by voice"); });
}
/* Tap the mic: start listening, or stop when it is listening already. → { transcript } or { error, code } */
export async function startVoiceSearch(target){
  const input = document.getElementById(target);
  if(!input) return { error: 'Search field unavailable.' };
  if(listening === target){ tryVoice(v => v.stop(true)); return { stopped: true }; }
  if(!voiceSearchAvailable()){ show(target, "bad", `<span class="vs-t">${WHY.unsupported()}</span>`); return { error: WHY.unsupported(), code: "unsupported" }; }
  if(!voiceSecure()){ show(target, "bad", `<span class="vs-t">${WHY.insecure()}</span>`); return { error: WHY.insecure(), code: "insecure" }; }
  const perm = await (tryVoice(v => typeof v.permission === 'function' ? v.permission() : 'unknown') || 'unknown');
  if(perm === 'denied'){ show(target, "bad", `<span class="vs-t">${WHY.denied()}</span>${again(target)}`); return { error: WHY.denied(), code: "denied" }; }
  listening = target; setButtons(target, true);
  const before = input.value;
  show(target, "listening", `<span class="vs-dot" aria-hidden="true"></span><span class="vs-t">${perm === 'prompt' ? "Allow the microphone when the browser asks, then say a product name." : "Listening… say a product name, size or colour."}</span><button type="button" class="btn sm" data-voice-stop="${esc(target)}">Stop</button>`);
  try{
    const transcript = String(await voice().listen({ lang: 'en-IN', onInterim: text => {
      input.value = text;
      show(target, "listening", `<span class="vs-dot" aria-hidden="true"></span><span class="vs-t">Hearing <q>${esc(text)}</q></span><button type="button" class="btn sm" data-voice-stop="${esc(target)}">Stop</button>`);
    } }) || '').trim();
    if(!transcript) throw Object.assign(new Error(WHY["no-speech"]()), { code: "no-speech" });
    input.value = transcript; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus({ preventScroll: true });
    show(target, "", `<span class="vs-t">Searching for <q>${esc(transcript)}</q></span>`, 4000);
    return { transcript };
  }catch(error){
    const code = error && error.code || "failed";
    if(input.value !== before && code !== "aborted"){ input.value = before; input.dispatchEvent(new Event('input', { bubbles: true })); }
    if(code === "aborted"){ show(target, "", ""); return { error: error.message, code }; }
    const why = (WHY[code] || WHY.failed)();
    show(target, "bad", `<span class="vs-t">${esc(why)}</span>${code === "unsupported" || code === "insecure" ? "" : again(target)}`);
    return { error: why, code };
  }finally{ listening = ""; setButtons(target, false); }
}

let installed = false;
export function installVoiceSearch(){
  if(installed) return; installed = true;
  // the static mic on Sell: shown everywhere; a browser without speech says so when tapped (typing always works)
  $$('[data-voice-search]').forEach(b => { b.hidden = false; b.classList.toggle("unsupported", !(voiceSearchAvailable() && voiceSecure())); });
  document.addEventListener('click', event => {
    const t = event.target && event.target.closest ? event.target : null; if(!t) return;
    const stop = t.closest('[data-voice-stop]');
    if(stop){ event.preventDefault(); tryVoice(v => v.stop(true)); return; }
    const b = t.closest('[data-voice-search]');
    if(!b) return; event.preventDefault(); startVoiceSearch(b.dataset.voiceSearch);
  });
  document.addEventListener('keydown', event => { if(event.key === 'Escape' && listening){ tryVoice(v => v.stop(false)); event.stopPropagation(); } }, true);
}

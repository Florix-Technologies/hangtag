// Voice search for the product search boxes (Sell, Products): the browser's own speech recognition ("voiceInput" port,
// infrastructure/browser/browser-speech.js), no paid service. The microphone is asked for only when the person taps Voice:
// the app asks the browser for it directly, so the browser's own prompt always appears when it hasn't been answered. The
// button and the line under the search say where it is — not asked yet · asking (the browser's prompt is up) · listening ·
// blocked — and what it hears; the words go in the search box, which searches by itself. Tap again (or Stop, or Esc) to
// stop. A message (blocked, nothing heard…) can be closed and goes by itself: nothing stays red. Typing and barcode
// scanning always keep working.
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
/* The Voice button's state: "idle" (not asked yet, or ready) · "asking" (the browser's prompt is up) · "listening" ·
   "blocked" (the microphone was refused: the button stays usable — a tap says how to allow it) */
const STATE_LABELS = { idle: "Search by voice", asking: "Waiting for the microphone permission", listening: "Stop listening", blocked: "Microphone blocked — search by voice" };
function setState(target, state){
  $$(`[data-voice-search="${target}"]`).forEach(b => { b.dataset.voiceState = state; b.classList.toggle("listening", state === "listening");
    b.setAttribute("aria-pressed", String(state === "listening")); b.setAttribute("aria-label", STATE_LABELS[state] || STATE_LABELS.idle); });
}
const setButtons = (target, on) => setState(target, on ? "listening" : "idle");
const closeBtn = target => `<button type="button" class="iconbtn vs-x" data-voice-dismiss="${esc(target)}" aria-label="Close">×</button>`;
/* Tap the mic: start listening, or stop when it is listening already. → { transcript } or { error, code } */
export async function startVoiceSearch(target){
  const input = document.getElementById(target);
  if(!input) return { error: 'Search field unavailable.' };
  if(listening === target){ tryVoice(v => v.stop(true)); return { stopped: true }; }
  if(!voiceSearchAvailable()){ show(target, "bad", `<span class="vs-t">${WHY.unsupported()}</span>`); return { error: WHY.unsupported(), code: "unsupported" }; }
  if(!voiceSecure()){ show(target, "bad", `<span class="vs-t">${WHY.insecure()}</span>`); return { error: WHY.insecure(), code: "insecure" }; }
  // the microphone, asked for from this tap: the browser's prompt when it hasn't been answered (Safari and Firefox can't
  // say beforehand, Chrome may say "prompt"); nothing is asked before the person taps Voice
  let perm = await (tryVoice(v => typeof v.permission === 'function' ? v.permission() : 'unknown') || 'unknown'), justAllowed = false;
  if(perm !== 'granted' && tryVoice(v => typeof v.requestMic === 'function')){
    setState(target, "asking");
    show(target, "asking", `<span class="vs-dot" aria-hidden="true"></span><span class="vs-t">Allow the microphone in the browser's prompt to search by voice.</span>`);
    const got = await tryVoice(v => v.requestMic());
    if(got === 'denied'){ setState(target, "blocked"); show(target, "bad", `<span class="vs-t">${WHY.denied()}</span>${closeBtn(target)}`, 9000); return { error: WHY.denied(), code: "denied" }; }
    if(got === 'no-mic'){ setState(target, "idle"); show(target, "bad", `<span class="vs-t">${WHY["no-mic"]()}</span>${closeBtn(target)}`, 9000); return { error: WHY["no-mic"](), code: "no-mic" }; }
    justAllowed = got === 'granted' && perm !== 'granted'; perm = got === 'granted' ? 'granted' : perm;
  }
  listening = target; setButtons(target, true);
  const before = input.value;
  show(target, "listening", `<span class="vs-dot" aria-hidden="true"></span><span class="vs-t">Listening… say a product name, size or colour.</span><button type="button" class="btn sm" data-voice-stop="${esc(target)}">Stop</button>`);
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
    // the microphone was allowed a moment ago in the browser's prompt, but speech couldn't start from that same tap
    // (some browsers want a fresh tap): one more tap starts it — not a "blocked" message
    if(code === "denied" && justAllowed){ show(target, "", `<span class="vs-t">Microphone allowed. Tap the mic again and speak.</span>`, 6000); return { error: "Tap again", code: "tap-again" }; }
    const why = (WHY[code] || WHY.failed)();
    if(code === "denied"){ listening = ""; setState(target, "blocked"); }
    show(target, "bad", `<span class="vs-t">${esc(why)}</span>${code === "unsupported" || code === "insecure" || code === "denied" ? "" : again(target)}${closeBtn(target)}`, 9000);
    return { error: why, code };
  }finally{ const blocked = $$(`[data-voice-search="${target}"]`).some(b => b.dataset.voiceState === "blocked"); listening = ""; if(!blocked) setButtons(target, false); }
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
    const dismiss = t.closest('[data-voice-dismiss]');
    if(dismiss){ event.preventDefault(); show(dismiss.dataset.voiceDismiss, "", ""); return; }
    const b = t.closest('[data-voice-search]');
    if(!b) return; event.preventDefault(); startVoiceSearch(b.dataset.voiceSearch);
  });
  document.addEventListener('keydown', event => { if(event.key === 'Escape' && listening){ tryVoice(v => v.stop(false)); event.stopPropagation(); } }, true);
}

// Browser speech input/output adapter (the Web Speech API: Chrome on desktop and Android, Edge, Safari). It is optional:
// unsupported or denied speech never interferes with typed search. No paid service: the browser does the recognition.
// listen() rejects with an Error whose `code` says why: "unsupported", "insecure" (speech needs https), "denied"
// (microphone permission), "no-mic", "no-speech", "network" (the browser's speech service is online), "aborted", "failed".
const fail = (code, message) => Object.assign(new Error(message), { code });
const MESSAGES = {
  "not-allowed": ["denied", "Microphone permission was not allowed."],
  "service-not-allowed": ["denied", "Voice input is blocked for this site."],
  "audio-capture": ["no-mic", "No microphone was found on this device."],
  "no-speech": ["no-speech", "No words were heard. Try again or type your search."],
  "network": ["network", "Voice search needs an internet connection in this browser."],
  "aborted": ["aborted", "Voice search stopped."],
};
export function createBrowserSpeech({ scope = globalThis } = {}){
  let recognition = null;
  const Recognition = () => scope && (scope.SpeechRecognition || scope.webkitSpeechRecognition);
  return Object.freeze({
    available: () => typeof Recognition() === 'function',
    /* false only where the browser says the page isn't secure (speech recognition needs https or localhost) */
    secure: () => !(scope && scope.isSecureContext === false),
    /* "granted" | "denied" | "prompt" | "unknown" (browsers without the Permissions API for the microphone) */
    async permission(){
      try{
        const q = scope && scope.navigator && scope.navigator.permissions && await scope.navigator.permissions.query({ name: 'microphone' });
        return q && q.state ? q.state : 'unknown';
      }catch{ return 'unknown'; }
    },
    /* The words spoken, once the speaker pauses. onInterim(text) gets what is heard so far while they speak. */
    listen({ lang = 'en-IN', onInterim } = {}){
      const Ctor = Recognition();
      if(typeof Ctor !== 'function') return Promise.reject(fail('unsupported', 'Voice search is not available in this browser.'));
      if(scope && scope.isSecureContext === false) return Promise.reject(fail('insecure', 'Voice search needs the app to be opened over https.'));
      if(recognition) try{ recognition.abort(); }catch{ /* already stopped */ }
      return new Promise((resolve, reject) => {
        let settled = false, heard = '';
        const r = new Ctor(); recognition = r; r.lang = lang; r.interimResults = typeof onInterim === 'function'; r.continuous = false; r.maxAlternatives = 1;
        const finish = (fn, value) => { if(settled) return; settled = true; if(recognition === r) recognition = null; fn(value); };
        r.onresult = event => {
          const rows = Array.from(event.results || []);
          const done = rows.filter(row => row && row.isFinal !== false).map(row => row[0] && row[0].transcript || '').join(' ').trim();
          const all = rows.map(row => row && row[0] && row[0].transcript || '').join(' ').trim();
          if(done){ heard = done; finish(resolve, heard); return; }
          if(all && typeof onInterim === 'function') onInterim(all);
          heard = all;
        };
        r.onerror = event => { const m = MESSAGES[event && event.error] || ['failed', 'Voice search could not hear that. Try typing instead.']; finish(reject, fail(m[0], m[1])); };
        r.onend = () => heard ? finish(resolve, heard) : finish(reject, fail('no-speech', MESSAGES['no-speech'][1]));
        try{ r.start(); }catch(error){ finish(reject, fail('failed', error && error.message || 'Voice search could not start.')); }
      });
    },
    /* Stop listening now: what was heard so far is kept (stop), or dropped (abort) */
    stop(keep = true){ if(recognition){ try{ keep && recognition.stop ? recognition.stop() : recognition.abort(); }catch{ /* already stopped */ } } },
    canSpeak: () => !!(scope && scope.speechSynthesis && typeof scope.SpeechSynthesisUtterance === 'function'),
    speak(text, { lang = 'en-IN' } = {}){
      if(!(scope && scope.speechSynthesis && typeof scope.SpeechSynthesisUtterance === 'function')) return false;
      scope.speechSynthesis.cancel(); const utterance = new scope.SpeechSynthesisUtterance(String(text || '')); utterance.lang = lang; scope.speechSynthesis.speak(utterance); return true;
    },
  });
}

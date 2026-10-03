// Browser speech input/output adapter. It is optional: unsupported or denied speech never interferes with typed search.
export function createBrowserSpeech({ scope = globalThis } = {}){
  let recognition = null;
  const Recognition = () => scope && (scope.SpeechRecognition || scope.webkitSpeechRecognition);
  return Object.freeze({
    available: () => typeof Recognition() === 'function',
    listen({ lang = 'en-IN' } = {}){
      const Ctor = Recognition();
      if(typeof Ctor !== 'function') return Promise.reject(new Error('Voice search is not available in this browser.'));
      if(recognition) try{ recognition.abort(); }catch{ /* already stopped */ }
      return new Promise((resolve, reject) => {
        let settled = false, heard = '';
        const r = new Ctor(); recognition = r; r.lang = lang; r.interimResults = false; r.continuous = false; r.maxAlternatives = 1;
        const finish = (fn, value) => { if(settled) return; settled = true; if(recognition === r) recognition = null; fn(value); };
        r.onresult = event => {
          heard = Array.from(event.results || []).map(row => row && row[0] && row[0].transcript || '').join(' ').trim();
          if(heard) finish(resolve, heard);
        };
        r.onerror = event => finish(reject, new Error(event && event.error === 'not-allowed' ? 'Microphone permission was not allowed.' : 'Voice search could not hear that. Try typing instead.'));
        r.onend = () => heard ? finish(resolve, heard) : finish(reject, new Error('No words were heard. Try again or type your search.'));
        try{ r.start(); }catch(error){ finish(reject, error); }
      });
    },
    stop(){ if(recognition){ try{ recognition.abort(); }catch{ /* already stopped */ } recognition = null; } },
    canSpeak: () => !!(scope && scope.speechSynthesis && typeof scope.SpeechSynthesisUtterance === 'function'),
    speak(text, { lang = 'en-IN' } = {}){
      if(!(scope && scope.speechSynthesis && typeof scope.SpeechSynthesisUtterance === 'function')) return false;
      scope.speechSynthesis.cancel(); const utterance = new scope.SpeechSynthesisUtterance(String(text || '')); utterance.lang = lang; scope.speechSynthesis.speak(utterance); return true;
    },
  });
}

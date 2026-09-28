// A minimal stand-in for the browser pieces use cases touch (the sync pill, toasts, a re-render), so application code can
// run in Node unit tests. Every element is the same inert object; nothing is drawn.
import { override } from '../../src/shared/di/services.js';

export function installFakeDom(){
  const el = { innerHTML: '', textContent: '', className: '', title: '', hidden: false, checked: false, value: '', dataset: {},
    setAttribute(){}, removeAttribute(){}, querySelector(){ return el; }, querySelectorAll(){ return []; }, focus(){}, appendChild(){} };
  globalThis.document = { querySelector: (s) => (/^#(rsReplace|rsSafety)$/.test(s) ? null : el), querySelectorAll: () => [], body: { style: {} }, createElement: () => ({ ...el }) };
  return el;
}
/* The "storage" port in memory; fail(key) makes saving that key report a full device */
export function memStorage(){
  const mem = {}, failing = new Set();
  const port = {
    mem, fail: (k) => failing.add(k), heal: () => failing.clear(),
    get: (k, d) => (k in mem ? JSON.parse(mem[k]) : d),
    set: (k, v) => { if(failing.has(k)) return false; mem[k] = JSON.stringify(v); return true; },
    getRaw: (k) => (k in mem ? mem[k] : null), setRaw: (k, v) => { mem[k] = v; }, remove: (k) => { delete mem[k]; },
  };
  override({ storage: port, renderer: { renderAll(){}, setTab(){} } });
  return port;
}

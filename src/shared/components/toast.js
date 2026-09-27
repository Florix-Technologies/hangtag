// Toast notification (with optional undo).
import { store } from '../state/store.js';
import { $, esc } from '../dom.js';

export function toast(msg,undo){
  const h=$("#toastHost");clearTimeout(store.toastT);
  h.innerHTML=`<div class="toast" role="status"><span>${esc(msg)}</span>${undo?`<button data-act="undo">Undo</button>`:""}</div>`;
  if(undo)h.querySelector("[data-act=undo]").onclick=()=>{h.innerHTML="";undo()};
  store.toastT=setTimeout(()=>{h.innerHTML=""},undo?7000:3800);
}

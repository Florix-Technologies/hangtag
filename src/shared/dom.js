// DOM helpers: query, HTML escaping, keyed list patching.

/* ================= helpers ================= */

export const $=s=>document.querySelector(s);
export const $$=s=>Array.from(document.querySelectorAll(s));
export const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let tpl=null;   // made on first use, so importing this module needs no document (unit tests)
export function patchList(box,arr){
  const kids=Array.from(box.children);
  if(kids.length!==arr.length||kids.some(k=>!("_h" in k))){box.innerHTML=arr.join("");Array.from(box.children).forEach((k,i)=>{k._h=arr[i]});return}
  tpl=tpl||document.createElement("template");
  arr.forEach((h,i)=>{if(kids[i]._h===h)return;tpl.innerHTML=h;const n=tpl.content.firstElementChild;n._h=h;kids[i].replaceWith(n)});
}

// Chart tooltips.
import { $ } from '../dom.js';

export const tip=$("#tip");
export function showTip(t){
  const lines=[["tv",t.dataset.tipv],["tl2",t.dataset.tipl],["tl2",t.dataset.tipm]].filter(x=>x[1]);
  tip.replaceChildren(...lines.map(([c,v])=>{const d=document.createElement("div");d.className=c;d.textContent=v;return d}));
  tip.hidden=false;
  const g=t.closest("g.col"),a=(g&&g.querySelector(".bar"))||t,r=a.getBoundingClientRect(),tw=tip.offsetWidth,th=tip.offsetHeight;
  let x=r.left+r.width/2-tw/2;x=Math.max(8,Math.min(window.innerWidth-tw-8,x));
  let y=r.top-th-10;if(y<8)y=Math.min(window.innerHeight-th-8,r.bottom+10);
  tip.style.left=x+"px";tip.style.top=y+"px";
}
export const hideTip=()=>{tip.hidden=true};

/* Registered once at start-up (app/main.js). */
export function installTooltips(){
  document.addEventListener("pointerover",e=>{const t=e.target.closest&&e.target.closest("[data-tipv]");if(t)showTip(t)});
  document.addEventListener("pointerout",e=>{if(e.pointerType==="touch")return;const t=e.target.closest&&e.target.closest("[data-tipv]");if(t&&!(e.relatedTarget&&t.contains(e.relatedTarget)))hideTip()});
  document.addEventListener("focusin",e=>{const t=e.target.closest&&e.target.closest("[data-tipv]");if(t)showTip(t);else hideTip()});
  document.addEventListener("pointerdown",e=>{if(!(e.target.closest&&e.target.closest("[data-tipv]")))hideTip()});
  window.addEventListener("scroll",hideTip,{passive:true});
}

// Print, image, download, share and WhatsApp for receipts.
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { RECEIPT_CSS, receiptHTML } from '../components/receipt-view.js';
import { gstLines, payLines, receiptModel, receiptText } from './receipt-model.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { logger } from '../../../shared/logging/logger.js';

export function printSale(sid){
  const s=D().saleById[sid]; if(!s) return;
  const paper=store.settings.paper==="a4"?"a4":"80mm";
  const f=document.createElement("iframe");
  f.setAttribute("aria-hidden","true"); f.style.cssText="position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(f);
  const css=RECEIPT_CSS+(paper==="a4"?"@page{size:A4;margin:14mm}":"");
  const doc=f.contentWindow.document;
  doc.open(); doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.no)}</title><style>${css}</style></head><body>${receiptHTML(s,paper)}</body></html>`); doc.close();
  setTimeout(()=>{ try{ f.contentWindow.focus(); f.contentWindow.print(); }catch(e){ logger.error("Print failed:", e); toast("Couldn't open printing. Try Download instead."); } setTimeout(()=>f.remove(),60000); }, 250);
}
/* The receipt as a picture (for Download and for sharing to WhatsApp as a file where the phone allows it) */

export async function receiptPNG(s){
  const R=receiptModel(s), W=576, P=24, c=document.createElement("canvas"), x=c.getContext("2d");
  const F='"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  const ops=[];let y=P;
  const text=(t,o)=>{o=o||{};const size=o.size||22;ops.push({k:"t",t:String(t),x:o.align==="c"?W/2:o.align==="r"?W-P:P,y:y+size,size,bold:o.bold,align:o.align||"l",color:o.color});if(!o.keep)y+=size+(o.gap==null?8:o.gap)};
  const pair=(l,r,o)=>{o=o||{};text(l,Object.assign({},o,{keep:true}));text(r,Object.assign({},o,{align:"r"}))};
  const rule=()=>{ops.push({k:"r",y:y+4});y+=14};
  x.font=`22px ${F}`;
  const wrap=(t,max)=>{const words=String(t).split(" "),out=[];let cur="";words.forEach(w=>{const n=cur?cur+" "+w:w;if(x.measureText(n).width>max&&cur){out.push(cur);cur=w}else cur=n});if(cur)out.push(cur);return out};
  text(R.shop.name,{align:"c",bold:true,size:30});
  if(R.shop.address) wrap(R.shop.address,W-2*P).forEach(l=>text(l,{align:"c",size:19,gap:4}));
  if(R.shop.phone) text("Phone "+R.shop.phone,{align:"c",size:19,gap:4});
  if(R.shop.gstin) text("GSTIN "+R.shop.gstin,{align:"c",size:19,gap:4});
  rule(); pair("Bill",R.no,{size:20}); pair("Date",dtLong(R.t),{size:20}); if(R.cust) pair("Customer",R.cust.name,{size:20});
  if(R.void) text("CANCELLED",{align:"c",bold:true});
  rule();
  R.lines.forEach(l=>{wrap(l.name,W-2*P-150).forEach((ln,i)=>i===0?pair(ln,inr(l.amt),{bold:true,size:21}):text(ln,{bold:true,size:21}));text(`${l.var?l.var+" · ":""}${l.q} × ${inr(l.price)}`,{size:18,color:"#444"})});
  rule();
  const G=gstLines(R);
  pair("Subtotal",inr(R.sub)); if(R.disc) pair("Discount","−"+inrx(R.disc)); if(!R.incl) G.forEach(g=>pair(g.label,inrx(g.amount))); if(R.roundOff) pair("Round off",(R.roundOff>0?"+":"")+inrx(R.roundOff));
  pair("Total",inr(R.total),{bold:true,size:28}); if(R.incl) G.forEach(g=>pair("Includes "+g.label,inrx(g.amount),{size:18}));
  if(R.credit){pair("Exchange credit","−"+inr(R.credit));pair("Paid ("+R.pay+")",inr(R.paid),{bold:true})}
  else if(R.pays.length>1) payLines(R).forEach(p=>pair("Paid by "+p.label,inrx(p.amount)));
  else pair("Paid",R.pay);
  if(R.change) pair("Change",inrx(R.change));
  if(R.footer){y+=6;wrap(R.footer,W-2*P).forEach(l=>text(l,{align:"c",size:19}))}
  c.width=W; c.height=y+P;
  x.fillStyle="#fff"; x.fillRect(0,0,W,c.height);
  ops.forEach(o=>{ if(o.k==="r"){x.strokeStyle="#000";x.setLineDash([6,5]);x.beginPath();x.moveTo(P,o.y);x.lineTo(W-P,o.y);x.stroke();x.setLineDash([]);return}
    x.font=`${o.bold?"700 ":""}${o.size}px ${F}`; x.fillStyle=o.color||"#000"; x.textAlign=o.align==="c"?"center":o.align==="r"?"right":"left"; x.fillText(o.t,o.x,o.y); });
  return await new Promise(res=>c.toBlob(b=>res(b),"image/png"));
}
export async function downloadReceipt(sid){
  const s=D().saleById[sid]; if(!s) return;
  const b=await receiptPNG(s);
  if(b&&await use("files").saveFile(`receipt-${s.no}.png`,b,"image/png")) toast("Receipt downloaded.");
}
export async function shareReceipt(sid){
  const s=D().saleById[sid]; if(!s) return;
  const text=receiptText(s);
  try{
    const b=await receiptPNG(s), file=b&&new File([b],`receipt-${s.no}.png`,{type:"image/png"});
    if(file&&navigator.canShare&&navigator.canShare({files:[file]})){ await navigator.share({files:[file],title:"Bill "+s.no,text}); return; }
    if(navigator.share){ await navigator.share({title:"Bill "+s.no,text}); return; }
  }catch(e){ if(e&&e.name==="AbortError") return; logger.warn("Share failed:", e); }
  await downloadReceipt(sid);
}
export function waPhone(p){ let d=String(p||"").replace(/\D/g,""); if(d.length===10) d="91"+d; if(d.length===11&&d[0]==="0") d="91"+d.slice(1); return d.length>=11?d:""; }
export function whatsappReceipt(sid){
  const s=D().saleById[sid]; if(!s) return;
  const ph=waPhone(s.cust&&s.cust.phone);
  const url=`https://wa.me/${ph}?text=${encodeURIComponent(receiptText(s))}`;
  const w=window.open(url,"_blank","noopener");
  if(!w) location.href=url;
  toast(ph?"WhatsApp opened with the bill for "+s.cust.name+".":"WhatsApp opened with the bill. Pick who to send it to.");
}

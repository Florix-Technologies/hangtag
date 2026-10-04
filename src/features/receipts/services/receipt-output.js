// Browser print, image, download, share and "open WhatsApp" for receipts — all from the bill's invoice.
// (Thermal printers: features/printing. Sending through a provider: features/delivery.)
import { printDocument } from '../components/doc-actions.js';
import { invoiceModel } from './doc-models.js';
import { gstLines } from '../../../domain/invoices/invoice.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { RECEIPT_CSS, receiptHTML } from '../components/receipt-view.js';
import { invoiceFor, payLines, receiptText } from './receipt-model.js';
import { toast } from '../../../shared/components/toast.js';
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { inr, inrx } from '../../../shared/formatting/money.js';
import { logger } from '../../../shared/logging/logger.js';

/* The browser's print dialog, with a print-only page (80 mm receipt or A4 invoice, as set in Billing settings) */
export function printSale(sid,want){
  const s=D().saleById[sid]; if(!s) return;
  const paper=(want||store.settings.paper)==="a4"?"a4":"80mm";
  // an A4 bill prints in the shop's document template (the same as its PDF)
  if(paper==="a4"){ printDocument(invoiceModel(s)); return; }
  const f=document.createElement("iframe");
  f.setAttribute("aria-hidden","true"); f.style.cssText="position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(f);
  const css=RECEIPT_CSS+(paper==="a4"?"@page{size:A4;margin:14mm}":"");
  const doc=f.contentWindow.document;
  doc.open(); doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.no)}</title><style>${css}</style></head><body>${receiptHTML(s,paper)}</body></html>`); doc.close();
  setTimeout(()=>{ try{ f.contentWindow.focus(); f.contentWindow.print(); }catch(e){ logger.error("Print failed:", e); toast("Couldn't open printing. Try Download instead."); } setTimeout(()=>f.remove(),60000); }, 250);
}
const loadImage=src=>new Promise(res=>{ if(!src) return res(null); const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; });
/* The receipt as a picture (for Download and for sharing to WhatsApp as a file where the phone allows it) */
export async function receiptPNG(s){
  const I=invoiceFor(s), T=I.totals, W=576, P=24, c=document.createElement("canvas"), x=c.getContext("2d");
  const F='"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  const ops=[];let y=P;
  const logo=await loadImage(I.logo);
  if(logo){ const k=Math.min(1,240/logo.naturalWidth,110/logo.naturalHeight), w=logo.naturalWidth*k, h=logo.naturalHeight*k; ops.push({k:"i",img:logo,x:(W-w)/2,y,w,h}); y+=h+10; }
  const text=(t,o)=>{o=o||{};const size=o.size||22;ops.push({k:"t",t:String(t),x:o.align==="c"?W/2:o.align==="r"?W-P:P,y:y+size,size,bold:o.bold,align:o.align||"l",color:o.color});if(!o.keep)y+=size+(o.gap==null?8:o.gap)};
  const pair=(l,r,o)=>{o=o||{};text(l,Object.assign({},o,{keep:true}));text(r,Object.assign({},o,{align:"r"}))};
  const rule=()=>{ops.push({k:"r",y:y+4});y+=14};
  x.font=`22px ${F}`;
  const wrap=(t,max)=>{const words=String(t).split(" "),out=[];let cur="";words.forEach(w=>{const n=cur?cur+" "+w:w;if(x.measureText(n).width>max&&cur){out.push(cur);cur=w}else cur=n});if(cur)out.push(cur);return out};
  text(I.seller.name,{align:"c",bold:true,size:30});
  if(I.seller.address) wrap(I.seller.address,W-2*P).forEach(l=>text(l,{align:"c",size:19,gap:4}));
  if(I.seller.phone) text("Phone "+I.seller.phone,{align:"c",size:19,gap:4});
  if(I.seller.gstin) text("GSTIN "+I.seller.gstin,{align:"c",size:19,gap:4});
  if(T.tax>0) text(I.title,{align:"c",bold:true,size:20,gap:4});
  rule(); pair("Bill",I.number,{size:20}); pair("Date",dtLong(I.t),{size:20}); if(I.buyer){ pair("Customer",I.buyer.name,{size:20}); if(I.buyer.gstin) pair("GSTIN",I.buyer.gstin,{size:18}); }
  if(I.status==="cancelled") text("CANCELLED",{align:"c",bold:true});
  rule();
  I.lines.forEach(l=>{wrap(l.name,W-2*P-150).forEach((ln,i)=>i===0?pair(ln,inrx(l.gross),{bold:true,size:21}):text(ln,{bold:true,size:21}));
    text(`${l.variant?l.variant+" · ":""}${l.qtyText||l.qty} × ${inr(l.rate)}${l.unit?"/"+l.unit:""}`,{size:18,color:"#444"}); if(l.discount) pair("Discount"+(l.discountLabel?" "+l.discountLabel:""),"−"+inrx(l.discount),{size:18,color:"#444"})});
  rule();
  const G=gstLines(I);
  pair("Subtotal",inrx(T.subtotal)); if(T.discount) pair("Discount","−"+inrx(T.discount)); if(G.length&&!I.inclusive){ pair("Taxable amount",inrx(T.taxable)); G.forEach(g=>pair(g.label,inrx(g.amount))); }
  if(T.roundOff) pair("Round off",(T.roundOff>0?"+":"")+inrx(T.roundOff));
  pair("Total",inr(T.total),{bold:true,size:28}); if(G.length&&I.inclusive) G.forEach(g=>pair("Includes "+g.label,inrx(g.amount),{size:18}));
  if(T.credit){ pair("Exchange credit","−"+inr(T.credit)); pair("Amount due",inr(T.due),{bold:true}); }
  payLines(I).forEach(p=>pair("Paid by "+p.label,inrx(p.amount)));
  if(I.change) pair("Change",inrx(I.change));
  if(I.footer){y+=6;wrap(I.footer,W-2*P).forEach(l=>text(l,{align:"c",size:19}))}
  c.width=W; c.height=y+P;
  x.fillStyle="#fff"; x.fillRect(0,0,W,c.height);
  ops.forEach(o=>{ if(o.k==="i"){x.drawImage(o.img,o.x,o.y,o.w,o.h);return} if(o.k==="r"){x.strokeStyle="#000";x.setLineDash([6,5]);x.beginPath();x.moveTo(P,o.y);x.lineTo(W-P,o.y);x.stroke();x.setLineDash([]);return}
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
/* WhatsApp on this device, with the bill typed in: the person presses Send in WhatsApp (nothing is sent from here) */
export function whatsappReceipt(sid){
  const s=D().saleById[sid]; if(!s) return;
  const ph=waPhone(s.cust&&s.cust.phone);
  const url=`https://wa.me/${ph}?text=${encodeURIComponent(receiptText(s))}`;
  const w=window.open(url,"_blank","noopener");
  if(!w) location.href=url;
  toast(ph?"WhatsApp opened with the bill for "+s.cust.name+". Press Send there.":"WhatsApp opened with the bill. Pick who to send it to.");
}

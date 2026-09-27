// Stickers (labels) for products and variants: name, variant, price, SKU and the barcode or QR code stored against the
// variant. Each sticker is one vector SVG; printing uses the browser's print dialog, and a sticker can be downloaded as
// PNG (or the whole set as SVG). No printer-specific integration.
import { store } from '../../../shared/state/store.js';
import { vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { prod } from '../services/catalog.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { use } from '../../../shared/di/services.js';
import { logger } from '../../../shared/logging/logger.js';

/* Label sizes in mm; "a4" prints 3 × 8 labels of 70 × 37 mm on an A4 sheet */
export const STICKER_SIZES=[
  {id:"50x25",label:"50 × 25 mm",w:50,h:25},{id:"38x25",label:"38 × 25 mm",w:38,h:25},{id:"40x30",label:"40 × 30 mm",w:40,h:30},
  {id:"2x1in",label:"2 × 1 inch",w:50.8,h:25.4},{id:"100x50",label:"100 × 50 mm",w:100,h:50},{id:"a4",label:"A4 sheet, 3 × 8 labels",w:70,h:37,sheet:{cols:3,rows:8}},
];
export const STICKER_FIELDS=[["name","Product name"],["variant","Variant"],["price","Price"],["sku","SKU"],["code","Barcode / QR code"]];
const n2=x=>String(+(+x).toFixed(2));
const fit=(s,w,fs)=>{const max=Math.max(3,Math.floor(w/(fs*0.56)));s=String(s||"");return s.length>max?s.slice(0,max-1)+"…":s};
/* A code SVG placed inside the sticker at x, y with that width and height (mm), keeping its proportions */
function nest(svg,x,y,w,h){
  const vb=/viewBox="([^"]+)"/.exec(svg)[1],body=svg.slice(svg.indexOf(">")+1,svg.lastIndexOf("</svg>"));
  return `<svg x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">${body}</svg>`;
}

/* One sticker as an SVG string, sized in mm. item = { p, v }, size from STICKER_SIZES, show = { name, variant, price, sku, code } */
export function stickerSVG({p,v},size,show){
  const W=size.w,H=size.h,pad=Math.max(1.2,H*0.05),k=Math.min(1.8,H/25),type=p.code==="qr"?"qr":"barcode";
  const code=show.code&&v.bc?v.bc:"";
  let codeSvg="",textW=W-2*pad,bottom=H-pad;
  if(code){
    try{
      if(type==="qr"){
        const q=Math.min(H-2*pad,W*0.45);
        codeSvg=nest(use("qrCodeService").render(code,{margin:1}),W-pad-q,(H-q)/2,q,q);
        textW=W-3*pad-q;
      }else{
        const bh=Math.max(8,H*0.45);
        codeSvg=nest(use("barcodeService").render(code,{quiet:3}),pad,H-pad-bh,W-2*pad,bh);
        bottom=H-pad-bh-0.6;
      }
    }catch(e){logger.warn("Sticker code skipped:",e)}
  }
  const lines=[],fsN=3*k,fsV=2.5*k,fsP=3.3*k,fsS=2.1*k;
  if(show.name)lines.push({t:fit(p.name,textW,fsN),fs:fsN,w:700});
  const vl=show.variant?vLabel(v):"",price=show.price?"₹"+vPrice(p,v).toLocaleString("en-IN"):"";
  if(vl&&price&&(vl.length+price.length+3)*fsV*0.56<=textW){lines.push({t:vl,fs:fsV,w:500,right:price,rfs:fsP})}
  else{if(vl)lines.push({t:fit(vl,textW,fsV),fs:fsV,w:500});if(price)lines.push({t:price,fs:fsP,w:800})}
  if(show.sku&&v.sku)lines.push({t:fit("SKU "+v.sku,textW,fsS),fs:fsS,w:500});
  // fit the lines into the space above the barcode (or the whole height)
  const need=lines.reduce((a,l)=>a+Math.max(l.fs,l.rfs||0)*1.18,0),room=bottom-pad,sc=need>room?room/need:1;
  let y=pad,txt="";
  lines.forEach(l=>{
    const fs=l.fs*sc,rf=(l.rfs||0)*sc;y+=Math.max(fs,rf)*1.02;
    txt+=`<text x="${n2(pad)}" y="${n2(y)}" font-size="${n2(fs)}" font-weight="${l.w}">${esc(l.t)}</text>`;
    if(l.right)txt+=`<text x="${n2(pad+textW)}" y="${n2(y)}" font-size="${n2(rf)}" font-weight="800" text-anchor="end">${esc(l.right)}</text>`;
    y+=Math.max(fs,rf)*0.16;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(W)}mm" height="${n2(H)}mm" viewBox="0 0 ${n2(W)} ${n2(H)}" font-family="Arial,Helvetica,sans-serif" fill="#000">`+
    `<rect width="${n2(W)}" height="${n2(H)}" fill="#fff"/>${txt}${codeSvg}</svg>`;
}

/* ---------- dialog ---------- */
/* vids: the variants to print (default: every variant on sale) */
export function openStickers(pid,vids){
  const p=prod(pid);if(!p)return;
  const list=(vids&&vids.length?vids:variantsOf(p).map(v=>v.id));
  store.stickers={pid,vids:list,size:"50x25",copies:1,show:{name:true,variant:true,price:true,sku:true,code:true}};
  renderStickers();
}
function stickerItems(){
  const s=store.stickers,p=s&&prod(s.pid);if(!p)return [];
  return s.vids.map(id=>p.variants.find(v=>v.id===id)).filter(Boolean).map(v=>({p,v}));
}
export function renderStickers(){
  const s=store.stickers;if(!s)return;
  const p=prod(s.pid),items=stickerItems();if(!p||!items.length){closeModal();toast("Nothing to print.");return}
  const size=STICKER_SIZES.find(z=>z.id===s.size)||STICKER_SIZES[0],noCode=items.filter(i=>!i.v.bc).length;
  const total=items.length*s.copies,prev=items.slice(0,6).map(i=>`<div class="stk-prev">${stickerSVG(i,size,s.show)}</div>`).join("");
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet stickers" role="dialog" aria-modal="true" aria-labelledby="stkT">
    <div class="sh-head"><div class="sh-t"><h3 id="stkT">Print stickers · ${esc(p.name)}</h3><p>${items.length} ${items.length===1?"sticker":"different stickers"} × ${s.copies} = ${total} to print</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="pgrid">
      <label class="f"><span class="lab">Label size</span><select data-stksize>${STICKER_SIZES.map(z=>`<option value="${z.id}"${z.id===size.id?" selected":""}>${esc(z.label)}</option>`).join("")}</select></label>
      <label class="f"><span class="lab">Copies of each</span><input type="number" inputmode="numeric" min="1" max="500" data-stkcopies value="${s.copies}"></label>
    </div>
    <div class="stk-fields" role="group" aria-label="Show on the sticker">${STICKER_FIELDS.map(([k,l])=>`<label class="chk"><input type="checkbox" data-stkshow="${k}"${s.show[k]?" checked":""}> ${l}</label>`).join("")}</div>
    ${noCode&&s.show.code?`<p class="note">${noCode} of these ${noCode===1?"has":"have"} no ${p.code==="qr"?"QR code":"barcode"} yet and will print without one. Add codes in the product editor.</p>`:""}
    <div class="stk-grid">${prev}${items.length>6?`<p class="note">…and ${items.length-6} more.</p>`:""}</div>
    <div class="sh-foot"><span class="note">Uses your browser's print dialog: pick the label printer and set the paper to the label size.</span>
      <div class="sh-acts">${items.length===1?`<button class="btn sm" data-stkact="png">Download PNG</button>`:""}<button class="btn sm" data-stkact="svg">Download SVG</button><button class="btn sm primary" data-stkact="print">Print ${total}</button></div></div>
  </div></div>`;
}
/* Every sticker to print (copies included), as SVG strings */
function allStickers(){
  const s=store.stickers,size=STICKER_SIZES.find(z=>z.id===s.size)||STICKER_SIZES[0],out=[];
  stickerItems().forEach(i=>{const svg=stickerSVG(i,size,s.show);for(let c=0;c<s.copies;c++)out.push(svg)});
  return {size,out};
}
export function printStickers(){
  const {size,out}=allStickers();if(!out.length)return;
  const sheet=size.sheet;
  const css=sheet?`@page{size:A4;margin:10mm 0 0 0}body{margin:0}.g{display:grid;grid-template-columns:repeat(3,${size.w}mm);grid-auto-rows:${size.h}mm;justify-content:center}.g svg{display:block}`
    :`@page{size:${size.w}mm ${size.h}mm;margin:0}body{margin:0}.g svg{display:block;page-break-after:always;break-after:page}`;
  const f=document.createElement("iframe");
  f.setAttribute("aria-hidden","true");f.style.cssText="position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(f);
  const doc=f.contentWindow.document;
  doc.open();doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Stickers</title><style>${css}</style></head><body><div class="g">${out.join("")}</div></body></html>`);doc.close();
  setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){logger.error("Print failed:",e);toast("Couldn't open printing. Try Download instead.")}setTimeout(()=>f.remove(),60000)},250);
}
export async function downloadStickers(kind){
  const s=store.stickers,p=prod(s.pid),{size,out}=allStickers();if(!out.length||!p)return;
  const base=`stickers-${p.name.replace(/[^\w-]+/g,"-").toLowerCase()}`;
  if(kind==="png"){
    try{const b=await use("files").svgToPng(out[0],{scale:12});await use("files").saveFile(base+".png",b,"image/png")}
    catch(e){logger.warn("PNG export failed:",e);toast("Couldn't make the picture. Try Download SVG.")}
    return;
  }
  // one SVG with the stickers stacked, 2 mm apart
  const gap=2,H=out.length*(size.h+gap)-gap;
  const body=out.map((svg,i)=>svg.replace(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="[^"]+" height="[^"]+"/,`<svg y="${n2(i*(size.h+gap))}" width="${n2(size.w)}" height="${n2(size.h)}"`)).join("");
  await use("files").saveFile(base+".svg",`<svg xmlns="http://www.w3.org/2000/svg" width="${n2(size.w)}mm" height="${n2(H)}mm" viewBox="0 0 ${n2(size.w)} ${n2(H)}">${body}</svg>`,"image/svg+xml");
}
/* Events inside the sticker dialog (wired in app/events) */
export function stickerChange(t){
  const s=store.stickers;if(!s)return false;
  if(t.matches("[data-stksize]")){s.size=t.value;renderStickers();return true}
  if(t.matches("[data-stkcopies]")){s.copies=Math.min(500,Math.max(1,Math.round(+t.value||1)));renderStickers();return true}
  if(t.matches("[data-stkshow]")){s.show[t.dataset.stkshow]=t.checked;renderStickers();return true}
  return false;
}
export function stickerAction(act){
  if(!store.stickers)return;
  if(act==="print")printStickers();else downloadStickers(act);
}

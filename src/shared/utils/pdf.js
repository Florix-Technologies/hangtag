// A small PDF writer for reports: a title, then blocks of text and tables, over as many A4 landscape pages as needed,
// with the standard Helvetica fonts (no embedding, no library). Text outside Latin-1 is written in plain letters
// ("₹" → "Rs "). Pure: returns the file as bytes (Uint8Array).
const W=842, H=595, M=36, FOOT=24;
const MAP={"₹":"Rs ","—":"-","–":"-","−":"-","…":"...","×":"x","✓":"v","✕":"x","•":"*","‘":"'","’":"'","“":'"',"”":'"'};
const latin=s=>String(s==null?"":s).replace(/[^\x20-\x7e\xa0-\xff]/g,c=>MAP[c]!==undefined?MAP[c]:"?");
const pdfStr=s=>"("+latin(s).replace(/[\\()]/g,c=>"\\"+c)+")";
/* Rough Helvetica widths (1/1000 em): enough to line up columns and right-align figures */
const cw=c=>/[0-9]/.test(c)?556:/[ il.,:;'|!]/.test(c)?278:/[mwMW@]/.test(c)?833:/[A-Z]/.test(c)?667:500;
export const textWidth=(s,size)=>[...latin(s)].reduce((a,c)=>a+cw(c),0)*size/1000;
const fit=(s,width,size)=>{let t=latin(s);if(textWidth(t,size)<=width)return t;while(t.length>1&&textWidth(t+"...",size)>width)t=t.slice(0,-1);return t+"..."};
const numeric=v=>typeof v==="number"||/^-?[\d,]+(\.\d+)?%?$/.test(String(v).trim());

const B64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Bytes(s){
  const clean=String(s||"").replace(/[^A-Za-z0-9+/=]/g,""); let out="",buf=0,bits=0;
  for(const c of clean){ if(c==="=") break; const n=B64.indexOf(c); if(n<0) continue; buf=(buf<<6)|n; bits+=6; if(bits>=8){ bits-=8; out+=String.fromCharCode((buf>>bits)&255); } }
  return out;
}
/* The receipt-logo flow stores a downscaled JPEG data URL. Keep the PDF dependency-free by embedding that JPEG as-is. */
function jpegLogo(url){
  const m=/^data:image\/jpeg;base64,([\s\S]+)$/i.exec(String(url||"")); if(!m) return null;
  const data=base64Bytes(m[1]); if(data.length<12||data.charCodeAt(0)!==255||data.charCodeAt(1)!==216) return null;
  for(let i=2;i+9<data.length;){
    if(data.charCodeAt(i)!==255){ i++; continue; }
    const marker=data.charCodeAt(i+1), len=(data.charCodeAt(i+2)<<8)|data.charCodeAt(i+3);
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      const h=(data.charCodeAt(i+5)<<8)|data.charCodeAt(i+6), w=(data.charCodeAt(i+7)<<8)|data.charCodeAt(i+8), comps=data.charCodeAt(i+9);
      return w&&h?{data,w,h,space:comps===1?"DeviceGray":comps===4?"DeviceCMYK":"DeviceRGB"}:null;
    }
    if(!len||len<2) break; i+=2+len;
  }
  return null;
}

/* doc: { title, subtitle?, footer?, logo? (JPEG data URL), blocks: [{ heading?, text?: [lines], head?: [cells], rows?: [[cells]] }] } */
export function pdfBytes(doc){
  const pages=[]; let ops=[], y=H-M; const logo=jpegLogo(doc.logo);
  const newPage=()=>{ if(ops.length) pages.push(ops); ops=[]; y=H-M; };
  const need=h=>{ if(y-h<M+FOOT) newPage(); };
  const text=(s,x,yy,size,bold)=>ops.push(`BT /${bold?"F2":"F1"} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td ${pdfStr(s)} Tj ET`);
  const rule=(yy,w=0.4)=>ops.push(`${w} w ${M} ${yy.toFixed(1)} m ${W-M} ${yy.toFixed(1)} l S`);
  let titleWidth=W-2*M;
  if(logo){ const k=Math.min(110/logo.w,45/logo.h), w=logo.w*k,h=logo.h*k; ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${(W-M-w).toFixed(1)} ${(H-M-h).toFixed(1)} cm /Im1 Do Q`); titleWidth-=w+12; }
  text(fit(doc.title||"Report",titleWidth,14),M,y-14,14,true); y-=20;
  if(doc.subtitle){ text(doc.subtitle,M,y-10,9,false); y-=16; }
  for(const b of doc.blocks||[]){
    if(b.heading){ need(40); y-=8; text(b.heading,M,y-10,10,true); y-=15; }
    for(const line of b.text||[]){ need(12); text(fit(line,W-2*M,8),M,y-9,8,false); y-=11; }
    if(b.head||b.rows){
      const head=b.head||[], rows=b.rows||[], n=Math.max(head.length,...rows.map(r=>r.length),1), size=rows.length>0&&n>10?6.5:7.5;
      const want=Array.from({length:n},(_,j)=>Math.min(160,Math.max(28,...[head,...rows].map(r=>textWidth(r[j]==null?"":r[j],size)+8))));
      const scale=Math.min(1,(W-2*M)/want.reduce((a,x)=>a+x,0)), widths=want.map(x=>x*scale), xs=widths.map((_,j)=>M+widths.slice(0,j).reduce((a,x)=>a+x,0));
      const row=(r,bold)=>{ need(11); r.forEach((v,j)=>{ if(j>=n) return; const t=fit(v==null?"":v,widths[j]-4,size); const right=!bold&&numeric(v);
        text(t,right?xs[j]+widths[j]-4-textWidth(t,size):xs[j],y-8,size,bold); }); y-=10.5; };
      if(head.length){ need(24); row(head,true); rule(y+2.5); }
      rows.forEach(r=>{ if(y-10.5<M+FOOT){ newPage(); if(head.length){ row(head,true); rule(y+2.5); } } row(r,false); });
      if(!rows.length){ need(11); text("None",M,y-8,size,false); y-=10.5; }
      y-=4;
    }
  }
  newPage();
  // footer on every page: the note and "page i of n"
  pages.forEach((p,i)=>{ if(doc.footer) p.push(`BT /F1 6.5 Tf ${M} ${M-4} Td ${pdfStr(fit(doc.footer,W-2*M-70,6.5))} Tj ET`);
    p.push(`BT /F1 6.5 Tf ${W-M-50} ${M-4} Td ${pdfStr(`Page ${i+1} of ${pages.length}`)} Tj ET`); });
  const objs=["<< /Type /Catalog /Pages 2 0 R >>",null,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  let imageId=0;
  if(logo){ objs.push(`<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace /${logo.space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.data.length} >>\nstream\n${logo.data}\nendstream`); imageId=objs.length; }
  const kids=[];
  pages.forEach(p=>{ const content=p.join("\n"); objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const cid=objs.length, xobj=imageId?` /XObject << /Im1 ${imageId} 0 R >>`:""; objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj} >> /Contents ${cid} 0 R >>`); kids.push(objs.length+" 0 R"); });
  objs[1]=`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out="%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"; const offs=[];
  objs.forEach((o,i)=>{ offs.push(out.length); out+=`${i+1} 0 obj\n${o}\nendobj\n`; });
  const xref=out.length;
  out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offs.map(o=>String(o).padStart(10,"0")+" 00000 n \n").join("");
  out+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes=new Uint8Array(out.length); for(let i=0;i<out.length;i++) bytes[i]=out.charCodeAt(i)&0xff;
  return bytes;
}

/* ---------- documents: an A4 portrait page in the shop's template (features/receipts/components/doc-render.js) ----------
   m: the document model (title, number, meta, seller, logo, parties, columns, left, rows, tax, totals, words, notes, terms,
   bank, signature, signImg, stampImg (JPEG data URLs, drawn at the signature), notice, footer, cancelled);
   o: { template: "standard"|"classic"|"modern"|"compact" ("minimal": the earlier name of standard), accent: "#rrggbb" }.
   Same content as the printed page; Helvetica, figures right-aligned, the table head repeated on every page. */
const PW=595, PH=842, PM=40;
const rgb=hex=>{const m=/^#?([0-9a-f]{6})$/i.exec(String(hex||""));const n=m?parseInt(m[1],16):0x1d5bbf;return [(n>>16&255)/255,(n>>8&255)/255,(n&255)/255].map(x=>x.toFixed(3)).join(" ")};
function wrap(s,width,size){
  const out=[];
  String(s==null?"":s).split(/\r?\n/).forEach(par=>{let line="";par.split(/\s+/).filter(Boolean).forEach(w=>{const t=line?line+" "+w:w;if(textWidth(t,size)<=width)line=t;else{if(line)out.push(line);line=textWidth(w,size)<=width?w:fit(w,width,size)}});out.push(line)});
  return out.filter((l,i,a)=>l||i<a.length-1);
}
export function docPdfBytes(m,o={}){
  const tpl=o.template||"modern", ACC=rgb(o.accent), minimal=tpl==="minimal"||tpl==="standard", classic=tpl==="classic", compact=tpl==="compact";
  const INK="0.106 0.122 0.165", GRAY="0.42 0.44 0.52", DARK="0.23 0.25 0.31";
  const pages=[]; let ops=[], y=PH-PM; const logo=jpegLogo(m.logo), sign=jpegLogo(m.signImg), stamp=jpegLogo(m.stampImg);
  const cell=c=>c&&typeof c==="object"?c:{t:c==null?"":String(c)};
  const text=(s,x,yy,size,bold,color)=>ops.push(`${color||INK} rg BT /${bold?"F2":"F1"} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td ${pdfStr(s)} Tj ET`);
  const rtext=(s,xr,yy,size,bold,color)=>text(s,xr-textWidth(s,size),yy,size,bold,color);
  const line=(x1,y1,x2,y2,w,color)=>ops.push(`${color||"0.79 0.80 0.84"} RG ${w||0.6} w ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S`);
  const box=(x,yy,w,h,fill)=>ops.push(`${fill} rg ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  const newPage=()=>{ if(ops.length) pages.push(ops); ops=[]; y=PH-PM; };
  // header: the shop (logo, name, address) and the document's title and numbers
  let lx=PM;
  if(logo){ const k=Math.min(90/logo.w,48/logo.h), w=logo.w*k, h=logo.h*k; ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${PM} ${(y-h).toFixed(1)} cm /Im1 Do Q`); lx=PM+w+10; }
  text(fit(m.seller.name,250,13),lx,y-12,13,true);
  let sy=y-26; (m.seller.lines||[]).filter(Boolean).forEach(l=>{ text(fit(l,250,8),lx,sy,8,false,GRAY); sy-=10; });
  rtext(fit(String(m.title||"").toUpperCase(),220,16),PW-PM,y-14,16,true,minimal?INK:ACC);
  // a long value wraps onto the next line instead of losing its end (a place of supply keeps its state code)
  let my=y-30; (m.meta||[]).filter(r=>r&&r[1]).forEach(([k,v])=>{ wrap(v,120,8.5).forEach((l,i)=>{ rtext(l,PW-PM,my,8.5,true); if(!i) rtext(k,PW-PM-128,my,8.5,false,GRAY); my-=11; }); });
  y=Math.min(sy,my,y-(logo?52:30))-6;
  if(classic){ line(PM,y,PW-PM,y,1.2,ACC); line(PM,y-2.5,PW-PM,y-2.5,0.5,ACC); y-=10; } else { line(PM,y,PW-PM,y,minimal?0.6:1.6,minimal?"0.84 0.85 0.89":ACC); y-=12; }
  if(m.cancelled){ box(PM,y-18,PW-2*PM,18,"0.99 0.93 0.93"); text("CANCELLED"+(m.cancelled===true?"":" - "+m.cancelled),PM+8,y-12.5,9,true,"0.79 0.21 0.21"); y-=26; }
  // who it is for (and a second party: deliver to)
  const parties=m.parties||[];
  if(parties.length){
    const colW=(PW-2*PM-14*(parties.length-1))/parties.length; let low=y;
    parties.forEach((p,i)=>{ const x=PM+i*(colW+14); let py=y; text(String(p.label||"").toUpperCase(),x,py-7,6.5,true,GRAY); py-=18; text(fit(p.name||"-",colW,10),x,py,10,true); py-=11;
      (p.lines||[]).filter(Boolean).forEach(l=>{ text(fit(l,colW,8),x,py,8,false,DARK); py-=10; }); low=Math.min(low,py); });
    y=low-8;
  }
  // the lines
  const cols=m.columns||[], size=(cols.length>8?7:7.8)-(compact?0.6:0), leftN=Math.max(1,Math.min(3,m.left||2)), rows=m.rows||[], HH=compact?13:15;
  const nameCol=cols[0]==="#"?1:0;
  const want=cols.map((h,j)=>Math.min(j===nameCol?240:110,Math.max(26,textWidth(h,size)+10,...rows.map(r=>{const c=cell(r[j]);return Math.max(textWidth(c.t,size),c.sub?textWidth(c.sub,size-1.4):0)+10;}))));
  const scale=(PW-2*PM)/Math.max(1,want.reduce((a,x)=>a+x,0)), widths=want.map(x=>x*scale), xs=widths.map((_,j)=>PM+widths.slice(0,j).reduce((a,x)=>a+x,0));
  const headColor=classic||minimal?INK:ACC;
  const head=()=>{ if(!minimal) box(PM,y-HH,PW-2*PM,HH,classic||compact?"0.95 0.95 0.96":"0.93 0.95 0.99");
    cols.forEach((h,j)=>{ const t=fit(String(h).toUpperCase(),widths[j]-6,6.5); if(j<leftN) text(t,xs[j]+3,y-HH+4.5,6.5,true,headColor); else rtext(t,xs[j]+widths[j]-3,y-HH+4.5,6.5,true,headColor); });
    y-=HH; line(PM,y,PW-PM,y,minimal?0.8:0.5,minimal?INK:"0.79 0.80 0.84"); };
  head();
  rows.forEach(r=>{
    const h=r.map(cell).some(c=>c.sub)?(compact?17:21):(compact?11:14);
    if(y-h<PM+30){ newPage(); head(); }
    const ry=compact?8:10;
    r.forEach((c0,j)=>{ const c=cell(c0), t=fit(c.t,widths[j]-6,size); if(j<leftN){ text(t,xs[j]+3,y-ry,size,j===nameCol); if(c.sub) text(fit(c.sub,widths[j]-6,size-1.4),xs[j]+3,y-ry-8,size-1.4,false,GRAY); } else rtext(t,xs[j]+widths[j]-3,y-ry,size,false); });
    y-=h; line(PM,y,PW-PM,y,0.4,classic?"0.79 0.80 0.84":"0.89 0.90 0.93");
  });
  if(!rows.length){ text("No items",PM+3,y-10,size,false,GRAY); y-=14; }
  y-=12;
  // totals on the right; tax by rate, amount in words, notes, terms and bank details on the left
  const tw=200, tx=PW-PM-tw, totals=m.totals||[];
  if(y-(totals.length*13+40)<PM+60) newPage();
  let ty=y, ly=y; const lw=tx-PM-18;
  totals.forEach(([k,v,g])=>{
    if(g){ ty-=4; if(minimal){ line(tx,ty,PW-PM,ty,1.4,ACC); text(k,tx,ty-13,10.5,true,ACC); rtext(v,PW-PM,ty-13,10.5,true,ACC); ty-=20; }
      else{ box(tx,ty-19,tw,19,ACC); text(k,tx+8,ty-13,10.5,true,"1 1 1"); rtext(v,PW-PM-8,ty-13,10.5,true,"1 1 1"); ty-=24; } }
    else{ text(fit(k,tw-80,8.5),tx,ty-10,8.5,false,DARK); rtext(v,PW-PM,ty-10,8.5,true); ty-=13; } });
  const block=(label,body)=>{ if(!body) return; text(label.toUpperCase(),PM,ly-7,6.5,true,GRAY); ly-=17;
    wrap(body,lw,8).forEach(l=>{ if(ly<PM+40){ newPage(); ly=PH-PM; ty=PH-PM; } text(l,PM,ly,8,false,DARK); ly-=10; }); ly-=6; };
  if(m.tax&&m.tax.rows.length){ const cw2=Math.min(64,lw/m.tax.head.length); m.tax.head.forEach((h,j)=>rtext(fit(h,cw2-6,6.5),PM+(j+1)*cw2-4,ly-8,6.5,true,GRAY)); ly-=12;
    m.tax.rows.forEach(r=>{ r.forEach((c,j)=>rtext(fit(c,cw2-6,7.5),PM+(j+1)*cw2-4,ly-8,7.5,false)); ly-=11; }); ly-=6; }
  block("Amount in words",m.words); block("Notes",m.notes); block("Terms & conditions",m.terms); block("Bank & payment details",m.bank);
  y=Math.min(ly,ty)-20;
  // the signature, and the document's notice
  if(y<PM+(sign||stamp?92:70)) newPage();
  const sx=PW-PM-170, lineY=sign?y-50:y-36;
  text(fit(m.signature||("For "+m.seller.name),170,8.5),sx,y-8,8.5,true);
  if(sign){ const k=Math.min(150/sign.w,32/sign.h), w=sign.w*k, h=sign.h*k; ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${(sx+(170-w)/2).toFixed(1)} ${(lineY+3).toFixed(1)} cm /Im2 Do Q`); }
  if(stamp){ const k=Math.min(66/stamp.w,66/stamp.h), w=stamp.w*k, h=stamp.h*k; ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${(sx-12-w).toFixed(1)} ${(lineY-12).toFixed(1)} cm /Im3 Do Q`); }
  line(sx,lineY,PW-PM,lineY,0.6,"0.60 0.63 0.68"); text("Authorised signatory",sx,lineY-10,7.5,false,GRAY);
  if(m.notice) wrap(m.notice,sx-PM-20,7.5).forEach((l,i)=>text(l,PM,y-40-i*9,7.5,false,GRAY));
  newPage();
  pages.forEach((p,i)=>{ if(m.footer) p.push(`0.29 0.31 0.38 rg BT /F1 7.5 Tf ${PM} ${PM-14} Td ${pdfStr(fit(m.footer,PW-2*PM-80,7.5))} Tj ET`);
    p.push(`0.42 0.44 0.52 rg BT /F1 7 Tf ${PW-PM-52} ${PM-14} Td ${pdfStr(`Page ${i+1} of ${pages.length}`)} Tj ET`); });
  const objs=["<< /Type /Catalog /Pages 2 0 R >>",null,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  // the pictures, once each: the logo (Im1), the authorised signature (Im2), the company stamp (Im3)
  const pics=[["Im1",logo],["Im2",sign],["Im3",stamp]].filter(x=>x[1]), ids={};
  pics.forEach(([n,im])=>{ objs.push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n${im.data}\nendstream`); ids[n]=objs.length; });
  const kids=[], xobj=pics.length?` /XObject << ${pics.map(([n])=>`/${n} ${ids[n]} 0 R`).join(" ")} >>`:"";
  pages.forEach(p=>{ const content=p.join("\n"); objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const cid=objs.length; objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj} >> /Contents ${cid} 0 R >>`); kids.push(objs.length+" 0 R"); });
  objs[1]=`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out="%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"; const offs=[];
  objs.forEach((ob,i)=>{ offs.push(out.length); out+=`${i+1} 0 obj\n${ob}\nendobj\n`; });
  const xref=out.length;
  out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offs.map(x=>String(x).padStart(10,"0")+" 00000 n \n").join("");
  out+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes=new Uint8Array(out.length); for(let i=0;i<out.length;i++) bytes[i]=out.charCodeAt(i)&0xff;
  return bytes;
}

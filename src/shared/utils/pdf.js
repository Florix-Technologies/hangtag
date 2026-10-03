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

// Reads an Excel workbook (.xlsx) without a library: the file is a ZIP of XML parts. Parts are unpacked here (stored, or
// deflated: DecompressionStream('deflate-raw'), built into browsers); the XML is read with the browser's DOMParser, or,
// where there is none (Node), with a small reader of the few elements needed. Cells come back as text, exactly as stored
// (numbers as written in the file, e.g. "599" or "0.05"), so the caller decides what each column means.
//   readXlsx(bytes) → [{ name, rows: [[text…]…] }] (every sheet, in workbook order)
// Pure apart from the decompression stream: the ZIP and the XML are read from the given bytes only.

const dec=new TextDecoder("utf-8");
const u16=(b,o)=>b[o]|(b[o+1]<<8), u32=(b,o)=>(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;
const fail=m=>{const e=new Error(m);e.code="XLSX";throw e};

/* Raw deflate → bytes (the browser's own decompressor) */
export async function inflateRaw(bytes){
  if(typeof DecompressionStream!=="function") fail("This browser can't open Excel files. Save the sheet as CSV and choose that instead.");
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/* The entries of a ZIP archive: { name: { method, data (compressed bytes), size } } */
export function zipEntries(bytes){
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  let end=-1;
  for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--) if(u32(b,i)===0x06054b50){end=i;break}
  if(end<0) fail("That file isn't an Excel workbook (.xlsx).");
  const n=u16(b,end+10), cdOff=u32(b,end+16), out={};
  if(cdOff===0xffffffff||n===0xffff) fail("That workbook is too large to read here. Save it as CSV and choose that instead.");
  let p=cdOff;
  for(let k=0;k<n;k++){
    if(u32(b,p)!==0x02014b50) fail("That Excel file looks damaged.");
    const method=u16(b,p+10), csize=u32(b,p+20), size=u32(b,p+24), nl=u16(b,p+28), xl=u16(b,p+30), cl=u16(b,p+32), lho=u32(b,p+42);
    const name=dec.decode(b.subarray(p+46,p+46+nl));
    if(u32(b,lho)!==0x04034b50) fail("That Excel file looks damaged.");
    const start=lho+30+u16(b,lho+26)+u16(b,lho+28);
    out[name]={method,size,data:b.subarray(start,start+csize)};
    p+=46+nl+xl+cl;
  }
  return out;
}
async function partText(entries,name,inflate){
  const e=entries[name]; if(!e) return null;
  if(e.method===0) return dec.decode(e.data);
  if(e.method===8) return dec.decode(await inflate(e.data));
  return fail("That Excel file uses a compression this app can't read. Save it as CSV and choose that instead.");
}

/* ---------- XML: one small node interface over DOMParser or plain text ---------- */
const ENT={amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
const unent=s=>String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi,(m,k)=>k[0]==="#"?String.fromCodePoint(k[1]==="x"||k[1]==="X"?parseInt(k.slice(2),16):+k.slice(1)):ENT[k]!=null?ENT[k]:m);
/* Plain-text reader: enough for workbook, relationships, shared strings and sheet parts (their elements don't nest in
   themselves). node = { attrs, inner } */
const textXml={
  root:xml=>({attrs:{},inner:String(xml).replace(/<\?[\s\S]*?\?>/g,"").replace(/<!--[\s\S]*?-->/g,"")}),
  find(node,tag){
    const re=new RegExp(`<(?:[\\w.-]+:)?${tag}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>)`,"g"), out=[];
    for(const m of node.inner.matchAll(re)){
      const attrs={}; for(const a of m[1].matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1]]=unent(a[3]!=null?a[3]:a[4]);
      out.push({attrs,inner:m[2]||""});
    }
    return out;
  },
  attr:(node,name)=>node.attrs[name]!=null?node.attrs[name]:null,
  text:node=>unent(node.inner.replace(/<[^>]*>/g,"")),
};
const domXml=DP=>({
  root(xml){ const d=new DP().parseFromString(String(xml),"application/xml"); if(d.getElementsByTagName("parsererror").length) fail("That Excel file looks damaged."); return d; },
  find:(node,tag)=>Array.from(node.getElementsByTagNameNS("*",tag)),
  attr:(node,name)=>node.getAttribute(name),
  text:node=>node.textContent||"",
});

const colIndex=ref=>{const m=/^([A-Z]+)/i.exec(String(ref||""));if(!m)return -1;let n=0;for(const ch of m[1].toUpperCase())n=n*26+(ch.charCodeAt(0)-64);return n-1};
/* The text of a shared or inline string: its runs' text, without phonetic guides (rPh) */
function stringText(X,node){
  if(X===textXml) return X.find({attrs:{},inner:node.inner.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh\s*>/g,"")},"t").map(X.text).join("");
  return X.find(node,"t").filter(t=>!(t.parentNode&&t.parentNode.localName==="rPh")).map(X.text).join("");
}
/* bytes: the .xlsx file (Uint8Array | ArrayBuffer). opts: { DOMParser (default: the browser's; none → the plain reader),
   inflate (default: inflateRaw) } → [{ name, rows }] */
export async function readXlsx(bytes,opts={}){
  const DP=opts.DOMParser!==undefined?opts.DOMParser:(typeof DOMParser==="function"?DOMParser:null);
  const X=DP?domXml(DP):textXml, inflate=opts.inflate||inflateRaw;
  const entries=zipEntries(bytes);
  const wb=await partText(entries,"xl/workbook.xml",inflate);
  if(wb==null) fail("That file isn't an Excel workbook (.xlsx).");
  const relsXml=await partText(entries,"xl/_rels/workbook.xml.rels",inflate), rels={};
  if(relsXml!=null) X.find(X.root(relsXml),"Relationship").forEach(r=>{rels[X.attr(r,"Id")]=X.attr(r,"Target")});
  const ssXml=await partText(entries,"xl/sharedStrings.xml",inflate);
  const shared=ssXml==null?[]:X.find(X.root(ssXml),"si").map(si=>stringText(X,si));
  const sheets=X.find(X.root(wb),"sheet").map((s,i)=>({name:X.attr(s,"name")||"Sheet"+(i+1),rid:X.attr(s,"r:id")}));
  const out=[];
  for(let i=0;i<sheets.length;i++){
    const t=rels[sheets[i].rid]||`worksheets/sheet${i+1}.xml`, path=t.startsWith("/")?t.slice(1):"xl/"+t.replace(/^\.\//,"");
    const xml=await partText(entries,path,inflate); if(xml==null) continue;
    const rows=[];
    X.find(X.root(xml),"row").forEach((r,k)=>{
      const rn=+X.attr(r,"r")||(rows.length?rows.length+1:k+1), row=[];
      X.find(r,"c").forEach((c,j)=>{
        const at=X.attr(c,"t")||"n", ci=colIndex(X.attr(c,"r")), col=ci<0?j:ci;
        const v=X.find(c,"v")[0], raw=v?X.text(v):"";
        let val;
        if(at==="s") val=shared[+raw]!=null?shared[+raw]:"";
        else if(at==="inlineStr"){ const is=X.find(c,"is")[0]; val=is?stringText(X,is):""; }
        else if(at==="b") val=raw==="1"?"TRUE":raw==="0"?"FALSE":raw;
        else val=raw;
        row[col]=val;
      });
      for(let j=0;j<row.length;j++) if(row[j]==null) row[j]="";
      while(rows.length<rn-1) rows.push([]);
      rows[rn-1]=row;
    });
    out.push({name:sheets[i].name,rows});
  }
  return out;
}

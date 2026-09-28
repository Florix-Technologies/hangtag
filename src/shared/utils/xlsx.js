// A small Excel workbook (.xlsx) writer: sheets of rows (strings and numbers), bold heading rows, no library.
// An .xlsx file is a ZIP of XML parts; the parts are stored uncompressed (Excel, LibreOffice and Sheets open it).
// Pure: returns the file as bytes (Uint8Array).
const enc=new TextEncoder();
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
export function crc32(bytes){let c=0xffffffff;for(let i=0;i<bytes.length;i++)c=CRC[(c^bytes[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0}
const u16=v=>[v&0xff,(v>>>8)&0xff], u32=v=>[v&0xff,(v>>>8)&0xff,(v>>>16)&0xff,(v>>>24)&0xff];
/* files: [{ name, data (string | Uint8Array) }] → a ZIP archive (stored, no compression) */
export function zipStore(files){
  const parts=[], central=[]; let offset=0;
  for(const f of files){
    const name=enc.encode(f.name), data=typeof f.data==="string"?enc.encode(f.data):f.data, crc=crc32(data);
    const head=Uint8Array.from([0x50,0x4b,0x03,0x04,...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),...u16(0)]);
    parts.push(head,name,data);
    central.push(Uint8Array.from([0x50,0x4b,0x01,0x02,...u16(20),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(data.length),...u32(data.length),
      ...u16(name.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset)]),name);
    offset+=head.length+name.length+data.length;
  }
  const cdSize=central.reduce((a,b)=>a+b.length,0);
  const end=Uint8Array.from([0x50,0x4b,0x05,0x06,...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(cdSize),...u32(offset),...u16(0)]);
  const all=[...parts,...central,end], out=new Uint8Array(all.reduce((a,b)=>a+b.length,0));
  let p=0; for(const b of all){out.set(b,p);p+=b.length}
  return out;
}
const CTRL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const xml=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]).replace(CTRL,"");
const col=n=>{let s="";n++;while(n){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26)}return s};
/* A sheet name Excel accepts: at most 31 characters, none of : \ / ? * [ ], and not used twice */
export function sheetName(n,used){
  const b=String(n||"Sheet").replace(/[:\\/?*[\]]/g," ").slice(0,31).trim()||"Sheet";
  let s=b,i=2; while(used.has(s.toLowerCase())) s=b.slice(0,28)+" "+i++;
  used.add(s.toLowerCase()); return s;
}
const HEAD='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', NS='http://schemas.openxmlformats.org', REL=NS+'/officeDocument/2006/relationships';
/* sheets: [{ name, rows: [[cell…]…], heads?: [row indexes shown bold] (default: the first) }]. Numbers stay numbers. */
export function xlsxBytes(sheets){
  const used=new Set(), named=sheets.map(s=>({...s,name:sheetName(s.name,used)}));
  const sheetXml=s=>{
    const bold=new Set(s.heads||[0]);
    const rows=(s.rows||[]).map((r,i)=>`<row r="${i+1}">${(r||[]).map((v,j)=>{
      const ref=col(j)+(i+1), st=bold.has(i)?' s="1"':"";
      if(v==null||v==="") return "";
      return typeof v==="number"&&Number.isFinite(v)?`<c r="${ref}"${st}><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join("")}</row>`).join("");
    return `${HEAD}<worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  };
  const files=[
    {name:"[Content_Types].xml",data:`${HEAD}<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`},
    {name:"_rels/.rels",data:`${HEAD}<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name:"xl/workbook.xml",data:`${HEAD}<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${named.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`},
    {name:"xl/_rels/workbook.xml.rels",data:`${HEAD}<Relationships xmlns="${NS}/package/2006/relationships">${named.map((s,i)=>`<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${named.length+1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`},
    {name:"xl/styles.xml",data:`${HEAD}<styleSheet xmlns="${NS}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`},
    ...named.map((s,i)=>({name:`xl/worksheets/sheet${i+1}.xml`,data:sheetXml(s)})),
  ];
  return zipStore(files);
}

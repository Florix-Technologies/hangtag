// The "receiptPrinter" port for Epson thermal printers (TM-m30, TM-T82, TM-T88 and others with ePOS-Print): the printer's
// own web service takes an ePOS-Print XML document over HTTP(S) and answers success or an error code. A print counts as
// done only when the printer answers success="true"; anything else is an AppError with a reason a person can act on.
// Epson specifics stay in this file: the app hands it printer-neutral lines (domain/receipts/thermal.js).
import { AppError, ERROR_CODES } from '../../shared/errors/app-error.js';

const NS="http://www.epson-pos.com/schemas/2011/03/epos-print";
const xml=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

/* The printer's ePOS-Print address, e.g. https://192.168.1.50/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000 */
export function eposUrl(cfg){
  return `${cfg.https===false?"http":"https"}://${cfg.host}/cgi-bin/epos/service.cgi?devid=${encodeURIComponent(cfg.devid||"local_printer")}&timeout=${cfg.timeout||10000}`;
}
/* The ePOS-Print request for a receipt (lines from domain/receipts/thermal.js; logo as a mono raster { width, height, base64 }) */
export function eposXml(doc,{logo}={}){
  const out=[`<epos-print xmlns="${NS}">`,`<text lang="en" smooth="true"/>`];
  const at=doc.logoAlign==="left"||doc.logoAlign==="right"?doc.logoAlign:"center";
  if(logo&&logo.base64) out.push(`<text align="${at}"/>`,`<image width="${logo.width}" height="${logo.height}" color="color_1" mode="mono">${logo.base64}</image>`,`<feed line="1"/>`);
  (doc.lines||[]).forEach(l=>out.push(`<text align="${l.align==="center"||l.align==="right"?l.align:"left"}" em="${l.bold?"true":"false"}" dw="${l.big?"true":"false"}" dh="${l.big?"true":"false"}">${xml(l.text)}&#10;</text>`));
  out.push(`<feed line="3"/>`,`<cut type="feed"/>`,`</epos-print>`);
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${out.join("")}</s:Body></s:Envelope>`;
}
/* The printer's answer: { success, code, status } (status is its status bit field) */
export function parseEposResponse(text){
  const m=/<response\b([^>]*)\/?>/i.exec(String(text||""));
  if(!m) return {success:false,code:"BadResponse",status:0};
  const attr=k=>{const a=new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]);return a?a[1]:""};
  return {success:attr("success")==="true",code:attr("code"),status:+attr("status")||0};
}
const MESSAGES={
  EPTR_COVER_OPEN:"The printer's cover is open. Close it and print again.",
  EPTR_REC_EMPTY:"The printer is out of paper. Load a roll and print again.",
  EPTR_CUTTER:"The printer's paper cutter is stuck. Check it and print again.",
  EPTR_AUTOMATICAL:"The printer stopped with an error. Check it and print again.",
  EPTR_MECHANICAL:"The printer has a mechanical error. Check it and print again.",
  EPTR_UNRECOVERABLE:"The printer has an error it can't recover from. Switch it off and on, then print again.",
  EX_TIMEOUT:"The printer didn't answer in time. Check it's switched on, then print again.",
  EX_BADPORT:"The printer isn't connected to its network box. Check the cable, then print again.",
  DeviceNotFound:"The printer's device ID wasn't found. Check the device ID in settings (usually local_printer).",
  PrintSystemError:"The printer's print service had an error. Switch the printer off and on, then try again.",
  SchemaError:"The printer didn't accept the receipt. Check the printer model supports ePOS-Print.",
  ParameterError:"The printer didn't accept the receipt. Check the printer model supports ePOS-Print.",
  BadResponse:"The printer's answer couldn't be read, so the receipt may not have printed.",
};
export const printerErrorMessage=code=>MESSAGES[code]||`The printer couldn't print (${code||"no reason given"}).`;

/* fetch: the browser's fetch · rasterize(dataUrl, maxWidth): the logo as a mono raster (browser only; may be left out) */
export function createEpsonPrinter({ fetch: send=(...a)=>globalThis.fetch(...a), rasterize }={}){
  async function post(cfg,body){
    const ctl=typeof AbortController!=="undefined"?new AbortController():null, wait=(cfg.timeout||10000)+5000;
    const timer=ctl?setTimeout(()=>ctl.abort(),wait):null;
    let res;
    try{
      res=await send(eposUrl(cfg),{method:"POST",headers:{"Content-Type":"text/xml; charset=utf-8","If-Modified-Since":"Thu, 01 Jan 1970 00:00:00 GMT","SOAPAction":'""'},body,signal:ctl?ctl.signal:undefined});
    }catch(e){
      throw new AppError(ERROR_CODES.PRINTER,`Can't reach the printer at ${cfg.host}. Check it's on and on the same Wi-Fi as this device.${cfg.https===false?"":" If it's the first time, open https://"+cfg.host+" once in this browser and accept its certificate."}`,{cause:e,details:{reason:"unreachable",retry:true}});
    }finally{ if(timer) clearTimeout(timer); }
    if(!res.ok) throw new AppError(ERROR_CODES.PRINTER,`The printer refused the receipt (HTTP ${res.status}).`,{details:{reason:"http",status:res.status,retry:true}});
    const r=parseEposResponse(await res.text());
    if(!r.success) throw new AppError(ERROR_CODES.PRINTER,printerErrorMessage(r.code),{details:{reason:"printer",code:r.code,status:r.status,retry:true}});
    return {ok:true,status:r.status};
  }
  return {
    /* doc: { cols, logo, lines } → { ok: true } once the printer confirms; throws an AppError (code PRINTER) otherwise */
    async print(doc,cfg){
      let logo=null;
      if(doc.logo&&rasterize){ try{ logo=await rasterize(doc.logo,doc.cols===32?256:320); }catch{ logo=null; } }   // a logo that can't be read prints without it
      return post(cfg,eposXml(doc,{logo}));
    },
    /* A short test receipt */
    test(cfg){ return post(cfg,eposXml({lines:[{text:"Hangtag test print",align:"center",bold:true},{text:"The printer is connected.",align:"center"}]})); },
  };
}

// The "weightScale" port: a weighing scale on this device. Two providers:
//   · manual   no scale: the weight is typed in the weight dialog (always available). A reading can be fed to it (tests, or
//              a scale that types into the page like a keyboard) and the next read() returns it.
//   · serial   a scale on a USB / RS-232 cable through Web Serial (Chrome, Edge on desktop and Android with USB OTG). It
//              reads text lines and understands any scale that prints "a number and a unit" (e.g. "ST,GS,+  1.250kg",
//              "W: 0.500 KG", "  750 g", "1.25"): no vendor protocol, no lock-in. Settings: baud rate, the unit a bare number
//              is in, and an optional command some scales need before they send the weight (e.g. "W" or "P").
// The person picks the port once (the browser asks); later it is opened again without asking (navigator.serial.getPorts()).
// Readings are never guessed: a scale still settling, a negative weight or nothing within the time allowed is an error the
// dialog shows, and typing stays available.

import { scaleSettingsOf } from '../../domain/shop/scale-settings.js';

/* Units a scale may print, as this app names them (lb and oz are converted by the caller: domain/catalog/units.js) */
const UNIT_WORDS={kg:"kg",kgs:"kg",g:"g",gm:"g",gms:"g",gr:"g",lb:"lb",lbs:"lb",oz:"oz",l:"l",lt:"l",ltr:"l",ml:"ml"};
const NUM=/([+-])?\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(kgs?|gms?|gr|g|lbs?|oz|ltr|lt|ml|l)?(?![a-z])/gi;

/* One line from a scale → { value, unit, stable } or null when it carries no weight. The last number on the line is the
   weight (headers such as "ST,GS," or "Net" come first); a line marked unstable ("US", "?", "MOTION") has stable false;
   a number without a unit is in defaultUnit. Pure. */
export function parseScaleLine(line,defaultUnit="kg"){
  const t=String(line==null?"":line).replace(/[\x00-\x1f\x7f]/g," ").trim();
  if(!t) return null;
  let m, last=null;
  NUM.lastIndex=0;
  while((m=NUM.exec(t))) last=m;
  if(!last) return null;
  const value=+(last[2].replace(",","."))*(last[1]==="-"?-1:1);
  if(!Number.isFinite(value)) return null;
  const unit=last[3]?UNIT_WORDS[last[3].toLowerCase()]:(UNIT_WORDS[String(defaultUnit||"kg").toLowerCase()]||"kg");
  const stable=!/\b(US|UNST(ABLE)?|MOTION|M)\b|\?/i.test(t.slice(0,last.index))&&!/\?/.test(t);
  return {value,unit,stable};
}

/* No scale: read() gives what was fed to it last (once), else says to type the weight */
export function createManualScale(){
  let fed=null;
  return {
    kind:"manual",
    supported:()=>false,
    status:()=>({connected:false,kind:"manual",name:""}),
    connect:async()=>({error:"This browser can't reach a scale on a cable. Type the weight instead."}),
    reconnect:async()=>false,
    disconnect:async()=>{},
    read:async()=>{ if(fed){ const r=fed; fed=null; return r; } return {error:"No scale is connected. Type the weight."}; },
    /* a line as a scale would print it ("1.250 kg"), for the next read() */
    feed(line,unit){ const r=parseScaleLine(line,unit); fed=r?r:null; return r; },
  };
}

/* A scale through Web Serial. serial: navigator.serial (absent: every call says so). getSettings(): the saved settings. */
export function createSerialScale({serial,getSettings}){
  let port=null, reader=null, reading=null, latest=null, waiters=[], buf="", name="";
  const settings=()=>scaleSettingsOf(getSettings&&getSettings());
  const deliver=r=>{ latest={...r,at:Date.now()}; const w=waiters; waiters=[]; w.forEach(f=>f(latest)); };
  async function pump(){
    const dec=new TextDecoder(), me=port;
    let ended=false;
    // a garbled byte (framing, buffer overrun) only replaces the port's stream: reading goes on with the new one. The loop
    // ends when the port is closed here (disconnect) or the cable is pulled (the port has no stream any more).
    while(port===me&&me.readable&&!ended){
      try{ reader=me.readable.getReader(); }catch{ break; }
      try{
        for(;;){
          const {value,done}=await reader.read(); if(done){ ended=true; break; }
          buf+=dec.decode(value,{stream:true});
          let i; while((i=buf.search(/[\r\n]/))>-1){ const line=buf.slice(0,i); buf=buf.slice(i+1); const r=parseScaleLine(line,settings().unit); if(r) deliver(r); }
          if(buf.length>256) buf=buf.slice(-64);
        }
      }catch{ /* a read error: try the port's next stream (none when the cable was pulled) */ }
      finally{ try{ reader.releaseLock(); }catch{ /* already released */ } reader=null; }
    }
    // the cable was pulled while this port was in use: it is no longer connected (status() shows it; typing still works)
    if(port===me&&!ended){ port=null; latest=null; const w=waiters; waiters=[]; w.forEach(f=>f(null)); try{ await me.close(); }catch{ /* already gone */ } }
  }
  async function open(p){
    const s=settings();
    await p.open({baudRate:s.baud,dataBits:8,stopBits:1,parity:"none",flowControl:"none"});
    port=p; buf=""; latest=null;
    const info=p.getInfo?p.getInfo():{}; name=info&&info.usbVendorId?`USB ${info.usbVendorId.toString(16)}:${(info.usbProductId||0).toString(16)}`:"Serial port";
    reading=pump();
  }
  return {
    kind:"serial",
    supported:()=>!!(serial&&serial.requestPort),
    status:()=>({connected:!!port,kind:"serial",name:port?name:""}),
    /* asks the person to choose the scale's port (needs a tap), then opens it */
    async connect(){
      if(!serial||!serial.requestPort) return {error:"This browser can't reach a scale on a cable (use Chrome or Edge). Type the weight instead."};
      try{ const p=await serial.requestPort(); if(port) await this.disconnect(); await open(p); return {ok:true,name}; }
      catch(e){ return {error:e&&e.name==="NotFoundError"?"No port was chosen.":"The scale's port couldn't be opened. Check the cable and the baud rate."}; }
    },
    /* opens the port this browser remembers, without asking (at start-up) → true when connected */
    async reconnect(){
      if(port) return true;
      if(!serial||!serial.getPorts) return false;
      try{ const ps=await serial.getPorts(); if(!ps.length) return false; await open(ps[0]); return true; }catch{ return false; }
    },
    async disconnect(){
      const p=port; port=null; latest=null; waiters.forEach(f=>f(null)); waiters=[];
      try{ if(reader) await reader.cancel(); }catch{ /* ignore */ }
      try{ if(reading) await reading; }catch{ /* ignore */ }
      try{ if(p) await p.close(); }catch{ /* ignore */ }
    },
    /* the next reading (a fresh one: sent after this call, or within the last second) → { value, unit, stable } or { error } */
    async read({timeoutMs=3000}={}){
      if(!port) return {error:"No scale is connected. Connect it in Settings → Team & Devices, or type the weight."};
      const s=settings();
      if(s.request&&port.writable){ const w=port.writable.getWriter(); try{ await w.write(new TextEncoder().encode(s.request+"\r\n")); }catch{ /* some scales only stream */ }finally{ w.releaseLock(); } }
      const fresh=latest&&Date.now()-latest.at<1000&&latest.stable?latest:null;
      const r=fresh||await new Promise(res=>{ let done=false; const f=x=>{ if(done) return; if(x&&!x.stable) return waiters.push(f); done=true; res(x); };
        waiters.push(f); setTimeout(()=>{ if(!done){ done=true; waiters=waiters.filter(g=>g!==f); res(latest&&!latest.stable?{unstable:true}:null); } },timeoutMs); });
      if(!r) return {error:"The scale sent no weight. Check that it is on and set to send readings, or type the weight."};
      if(r.unstable) return {error:"The scale is still settling. Wait a moment and read again."};
      return {value:r.value,unit:r.unit,stable:true};
    },
  };
}

/* The port: the serial scale where the browser has Web Serial (it falls back to manual when nothing is connected), manual
   elsewhere. feed() always reaches the manual provider. */
export function createWeightScale({serial,getSettings}={}){
  const manual=createManualScale(), cable=serial&&serial.requestPort?createSerialScale({serial,getSettings}):null;
  return {
    supported:()=>!!cable,
    status:()=>cable&&cable.status().connected?cable.status():manual.status(),
    connect:()=>cable?cable.connect():manual.connect(),
    reconnect:()=>cable?cable.reconnect():manual.reconnect(),
    disconnect:()=>cable?cable.disconnect():manual.disconnect(),
    read:opts=>cable&&cable.status().connected?cable.read(opts):manual.read(opts),
    feed:(line,unit)=>manual.feed(line,unit),
  };
}

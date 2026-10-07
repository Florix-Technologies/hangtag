// Settings → This device: this device's weighing scale. Connect a scale on a cable (Web Serial) with its baud rate, the unit a
// bare number is in and an optional command that asks for the weight; read a test weight; disconnect. Typing weights on the
// bill always works, with or without a scale.
import { BAUD_RATES, SCALE_UNITS } from '../../../domain/shop/scale-settings.js';
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { connectScale, disconnectScale, saveScaleSettings } from '../use-cases/scale.js';
import { readScaleFor, scaleStatus, scaleSupported } from '../services/scale.js';

const stateText=()=>{
  if(!scaleSupported()) return "This browser can't reach a scale on a cable (use Chrome or Edge on a computer or Android). Weights are typed on the bill.";
  const s=scaleStatus(); return s.connected?`Connected · ${s.name||"scale"}`:"No scale connected. Weights are typed on the bill until you connect one.";
};
export function scaleSetupHTML(){
  const s=store.scale||{}, on=scaleStatus().connected, sup=scaleSupported();
  return `<div class="setsec" id="scaleSetup"><h4>Weighing scale</h4>
    <p class="note" style="margin:0 0 8px">For products sold by the kg or litre. A scale on a USB or serial cable that sends its weight as text works (no particular brand needed).</p>
    <form id="scaleForm" class="authform" novalidate><div class="pgrid">
      <label class="f"><span class="lab">Baud rate</span><select name="baud">${BAUD_RATES.map(b=>`<option value="${b}"${+s.baud===b?" selected":""}>${b}</option>`).join("")}</select><span class="fhint">As set on the scale (often 9600)</span></label>
      <label class="f"><span class="lab">A weight without a unit is in</span><select name="unit">${SCALE_UNITS.map(u=>`<option value="${u}"${s.unit===u?" selected":""}>${u}</option>`).join("")}</select></label>
      <label class="f"><span class="lab">Command that asks for the weight</span><input name="request" maxlength="8" value="${esc(s.request||"")}" placeholder="None: the scale sends by itself" autocomplete="off"><span class="fhint">Only if the scale's manual names one, e.g. W or P</span></label>
      <label class="chk full"><input type="checkbox" name="auto"${s.auto!==false?" checked":""}> Connect the scale again when the app opens</label>
    </div>
    <p class="note" id="scaleState" style="margin:8px 0 0">${esc(stateText())}</p>
    <p id="scaleMsg" class="autherr" role="status" hidden></p>
    <div class="setactions"><button class="btn sm primary" type="submit">Save</button>${sup?`<button class="btn sm" type="button" data-act="scaleconnect">${on?"Choose another scale":"Connect scale"}</button>`:""}${on?`<button class="btn sm" type="button" data-act="scaletest">Read weight</button><button class="btn sm" type="button" data-act="scaleoff">Disconnect</button>`:""}</div></form></div>`;
}
const scaleInput=form=>{const f=new FormData(form);return {baud:f.get("baud"),unit:f.get("unit"),request:f.get("request")||"",auto:!!f.get("auto")}};
function scaleMsg(text,ok){const m=$("#scaleMsg");if(!m)return;m.textContent=text;m.hidden=!text;m.classList.toggle("okmsg",!!ok)}
function redraw(){const host=$("#scaleSetup");if(host)host.outerHTML=scaleSetupHTML()}
export function installScaleSettingsEvents(){
  document.addEventListener("submit",e=>{
    if(e.target.id!=="scaleForm") return;
    e.preventDefault(); const r=saveScaleSettings(scaleInput(e.target));
    if(r.error){scaleMsg(r.error);return} scaleMsg("Scale settings saved on this device.",true); toast("Scale settings saved.");
  });
  document.addEventListener("click",async e=>{
    const a=e.target.closest&&e.target.closest("#scaleSetup [data-act]"); if(!a) return;
    const form=$("#scaleForm");
    if(a.dataset.act==="scaleconnect"){ scaleMsg("Choose the scale's port…",true); const r=await connectScale(form?scaleInput(form):null); redraw(); if(r.error) scaleMsg(r.error); else toast("Scale connected."); return; }
    if(a.dataset.act==="scaleoff"){ await disconnectScale(); redraw(); toast("Scale disconnected."); return; }
    if(a.dataset.act==="scaletest"){ scaleMsg("Reading…",true); const r=await readScaleFor((store.scale||{}).unit==="l"||(store.scale||{}).unit==="ml"?"l":"kg"); scaleMsg(r.error||`✓ The scale reads ${r.text}.`,!r.error); }
  });
}

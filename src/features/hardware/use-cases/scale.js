// This device's weighing scale: save its settings, connect and disconnect it (Settings → Team & Devices). The settings stay on
// this device (each counter has its own scale). Whoever sells or runs the shop's settings may set it up.
import { checkScaleSettings } from '../../../domain/shop/scale-settings.js';
import { store } from '../../../shared/state/store.js';
import { saveScale } from '../../../shared/state/persistence.js';
import { denied } from '../../shop/services/access.js';
import { weightScale } from '../services/scale.js';

const SETUP=["create_sale","manage_settings"];
/* input: { baud, unit, request, auto } → { ok, scale } or { error, field } */
export function saveScaleSettings(input){
  const no=denied(SETUP,"set up the scale"); if(no) return no;
  const r=checkScaleSettings(input); if(r.error) return r;
  store.scale=r.scale; saveScale();
  return {ok:true,scale:r.scale};
}
/* Save the settings as typed, then ask the person to choose the scale's port → { ok, name } or { error } */
export async function connectScale(input){
  if(input){ const s=saveScaleSettings(input); if(s.error) return s; }
  else{ const no=denied(SETUP,"set up the scale"); if(no) return no; }
  try{ return await weightScale().connect(); }catch{ return {error:"The scale couldn't be connected."}; }
}
export async function disconnectScale(){
  try{ await weightScale().disconnect(); }catch{ /* already closed */ }
  return {ok:true};
}

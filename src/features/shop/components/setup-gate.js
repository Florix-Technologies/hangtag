// Required shop setup screen after first sign-in: shop name, type of business, then the details on the bills. The type's
// recommended capabilities apply by themselves (domain/shop/capabilities.js capsFor): no capability switches are asked here.
import { aEl, focusCard, setAppInert } from '../../../shared/components/gate.js';
import { requestEnterApp, requestSignOut } from '../../../shared/ui/session-actions.js';
import { profileFieldsHTML, readProfileForm } from './profile-form.js';
import { saveShopProfile } from '../use-cases/save-shop-profile.js';

export function showSetup(p){
  aEl("authGate").hidden = true;
  const g = aEl("setupGate");
  aEl("setupForm").innerHTML = profileFieldsHTML(p, "su", { needType: true }) + '<button id="setupSubmit" class="btn primary gbtn" type="submit">Save and open my shop</button>';
  aEl("setupErr").hidden = true;
  g.hidden = false;
  document.documentElement.classList.add("gated");
  setAppInert(true);
  focusCard(g);
}
export function hideSetup(){ aEl("setupGate").hidden = true; if(aEl("authGate").hidden){ document.documentElement.classList.remove("gated"); setAppInert(false); } }
export async function onSetupSubmit(ev){
  ev.preventDefault();
  const form = aEl("setupForm"), err = aEl("setupErr");
  const r = readProfileForm(form, { needType: true });   // the type of business decides the defaults (applied by themselves)
  if(r.error){ err.textContent = r.error; err.hidden = false; return; }
  const btn = aEl("setupSubmit"); btn.disabled = true; err.hidden = true;
  try{
    await saveShopProfile(r.values);
    hideSetup();
    await requestEnterApp(true);
  }catch(e){
    err.textContent = e.message || "Couldn't save. Try again."; err.hidden = false;
  }finally{ btn.disabled = false; }
}

/* Registered once at start-up (app/main.js). */
export function installSetupEvents(){
  aEl("setupForm").addEventListener("submit", onSetupSubmit);
  aEl("setupSignOut").addEventListener("click", () => requestSignOut());
}

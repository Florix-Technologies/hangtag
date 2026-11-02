// Console → Settings: Hangtag's commercial settings (AutoPay switched on, whether new trials need it, the plan it renews,
// when a trial counts as ending, the renewal grace) — seen by admins, changed by a super admin — and console access (who is
// on the console's team, with which role), managed by account id. Every change is checked and audited by the database.
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { ROLES, ROLE_LABELS, can } from '../../../domain/platform/console.js';
import { count, day, errorPanelHTML, loadingHTML, msgHTML, when } from '../services/console-ui.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const yes = b => (b ? "Yes" : "No");

function settingsHTML(s, st){
  if(!s) return "";
  if(!s.can_manage) return `<section class="pc-group" aria-labelledby="pcSetT"><h2 id="pcSetT">Plans and AutoPay</h2><div class="pc-card"><dl class="pc-dl">
    <div><dt>AutoPay set up</dt><dd>${yes(s.autopay_enabled)}</dd></div><div><dt>New trials need AutoPay</dt><dd>${yes(s.trial_requires_autopay)}</dd></div>
    <div><dt>Free trial</dt><dd>${esc(count(s.trial_days))} days</dd></div><div><dt>AutoPay renews</dt><dd><code>${esc(s.autopay_plan_code)}</code></dd></div>
    <div><dt>"Trial ending" from</dt><dd>${esc(count(s.trial_ending_days))} days before</dd></div><div><dt>Renewal grace</dt><dd>${esc(count(s.renewal_grace_hours))} hours</dd></div>
    <div><dt>AutoPay terms version</dt><dd><code>${esc(s.autopay_consent_version)}</code></dd></div></dl>
    <p class="note">Only a super admin changes these. Last changed ${esc(when(s.updated_at))}.</p></div></section>`;
  return `<section class="pc-group" aria-labelledby="pcSetT"><h2 id="pcSetT">Plans and AutoPay</h2>${msgHTML(st.setMsg, st.setTone)}
    <form class="pc-card pc-form" data-pc-settings novalidate>
      <label class="pc-check"><input type="checkbox" name="autopay_enabled"${s.autopay_enabled ? " checked" : ""}> AutoPay is set up</label>
      <label class="pc-check"><input type="checkbox" name="trial_requires_autopay"${s.trial_requires_autopay ? " checked" : ""}> New trials need AutoPay</label>
      <label class="pc-f"><span>AutoPay renews the plan</span><input name="autopay_plan_code" value="${esc(s.autopay_plan_code)}" pattern="[a-z0-9_]{1,20}" required></label>
      <label class="pc-f"><span>"Trial ending" from (days before)</span><input name="trial_ending_days" type="number" min="1" max="14" step="1" value="${esc(String(s.trial_ending_days))}"></label>
      <label class="pc-f"><span>Renewal grace (hours)</span><input name="renewal_grace_hours" type="number" min="0" max="168" step="1" value="${esc(String(s.renewal_grace_hours))}"></label>
      <label class="pc-f"><span>AutoPay terms version</span><input name="autopay_consent_version" value="${esc(s.autopay_consent_version)}" pattern="[a-z0-9._-]{3,40}"></label>
      <p class="note pc-wide">Switch "AutoPay is set up" on only once the subscription function has its AutoPay plan at the provider: from then on, new trials start
        with AutoPay (nothing to pay today). A new terms version asks owners to agree again. The free trial's length is the trial plan's (Promotions → Plans).</p>
      <div class="pc-formbtns"><button type="submit" class="btn primary sm">Save</button></div></form></section>`;
}
function staffHTML(list, st, me){
  if(!list) return "";
  const roles = me.role === "super_admin" ? ROLES : ROLES.filter(r => r !== "super_admin" && r !== "admin");
  return `<section class="pc-group" aria-labelledby="pcStaffT"><h2 id="pcStaffT">Console access</h2>${msgHTML(st.staffMsg, st.staffTone)}
    <div class="pc-table-wrap"><table class="pc-table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Since</th><th><span class="sr">Change</span></th></tr></thead>
      <tbody>${list.map(s => `<tr><td>${esc(s.email || "")}${s.name ? ` <small>${esc(s.name)}</small>` : ""}<br><code>${esc(s.user_id)}</code></td><td>${esc(ROLE_LABELS[s.role] || s.role)}</td>
        <td>${s.active ? `<span class="chip-s ok nodot">Active</span>` : `<span class="chip-s nodot">Off</span>`}</td><td>${esc(day(s.created_at))}</td>
        <td><button type="button" class="btn sm" data-pc-staff="${esc(s.user_id)}" data-role="${esc(s.role)}" data-active="${s.active ? "1" : ""}">Change</button></td></tr>`).join("")}</tbody></table></div>
    <form class="pc-card pc-form" data-pc-staffform novalidate>
      <label class="pc-f pc-wide"><span>Account ID (from the console's "no access" page)</span><input name="user" value="${esc(st.staffUser || "")}" autocomplete="off" spellcheck="false" required></label>
      <label class="pc-f"><span>Role</span><select name="role">${roles.map(r => `<option value="${r}"${st.staffRole === r ? " selected" : ""}>${esc(ROLE_LABELS[r])}</option>`).join("")}</select></label>
      <label class="pc-f"><span>Name (optional)</span><input name="name" maxlength="60"></label>
      <label class="pc-check"><input type="checkbox" name="active"${st.staffActive === false ? "" : " checked"}> Has access</label>
      <div class="pc-formbtns"><button type="submit" class="btn primary sm">Save access</button></div></form></section>`;
}

export async function renderSettings(main, { me }){
  main.innerHTML = loadingHTML("Settings");
  const P = use("platform"), st = { setMsg: "", setTone: "", staffMsg: "", staffTone: "", staffUser: "", staffRole: "read_only", staffActive: true };
  let settings = null, staff = null;
  try{
    [settings, staff] = await Promise.all([can(me.perms, "settings.view") ? P.settings() : null, can(me.perms, "staff.manage") ? P.staff() : null]);
  }catch(e){ main.innerHTML = errorPanelHTML("Settings", e); return; }
  const draw = () => { main.innerHTML = `<div class="pc-page"><div class="pc-head"><h1>Settings</h1></div>${settingsHTML(settings, st)}${staffHTML(staff, st, me)}</div>`; };
  draw();
  main.onclick = e => {
    const b = e.target.closest && e.target.closest("[data-pc-staff]");
    if(!b) return;
    st.staffUser = b.dataset.pcStaff; st.staffRole = b.dataset.role; st.staffActive = !!b.dataset.active; st.staffMsg = ""; draw();
    const f = main.querySelector('[data-pc-staffform] select'); if(f) f.focus();
  };
  main.onsubmit = async e => {
    const form = e.target;
    if(form.matches("[data-pc-settings]")){
      e.preventDefault();
      const v = n => String(form.elements[n].value).trim(), on = n => form.elements[n].checked;
      try{
        settings = await P.saveSettings({ autopay_enabled: on("autopay_enabled"), trial_requires_autopay: on("trial_requires_autopay"), autopay_plan_code: v("autopay_plan_code"),
          trial_ending_days: v("trial_ending_days"), renewal_grace_hours: v("renewal_grace_hours"), autopay_consent_version: v("autopay_consent_version") });
        st.setMsg = "Saved. The change is in the audit log."; st.setTone = "ok";
      }catch(err){ st.setMsg = (err && err.message) || "Couldn't save."; st.setTone = "bad"; }
      draw();
    }else if(form.matches("[data-pc-staffform]")){
      e.preventDefault();
      const user = String(form.elements.user.value).trim(), role = form.elements.role.value, active = form.elements.active.checked, name = String(form.elements.name.value).trim();
      st.staffUser = user; st.staffRole = role; st.staffActive = active;
      if(!UUID.test(user)){ st.staffMsg = "Enter the account ID the person sees on the console's \"no access\" page."; st.staffTone = "bad"; draw(); return; }
      try{ staff = await P.saveStaff(user, role, active, name); st.staffMsg = "Saved. The change is in the audit log."; st.staffTone = "ok"; st.staffUser = ""; }
      catch(err){ st.staffMsg = (err && err.message) || "Couldn't save."; st.staffTone = "bad"; }
      draw();
    }
  };
}

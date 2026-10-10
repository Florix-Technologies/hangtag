// The Platform Console's confirmation for an action on a shop (suspend, restore, give a plan, extend, end sign-ins).
// Before anything is asked, the database previews exactly what the action would do (the action is run and rolled back, so
// nothing changes) and the dialog says it in plain words. A reason is required: the database keeps it in the audit log with
// who, the shop, before and after. The database checks the role again when the action is confirmed.
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { ACTIONS, actionConsequence } from '../../../domain/platform/console.js';
import { day, money } from '../services/console-ui.js';

/* host: where the dialog goes (the open panel). Resolves to the action's result once done, or null if cancelled. */
export function confirmAction(host, { owner, action, shopName, plans = [] }){
  const P = use("platform"), A = ACTIONS[action];
  const paid = plans.filter(p => p && p.code);
  const st = { plan: paid.length ? paid[0].code : "", days: 7, preview: null, err: "", busy: false, seq: 0 };
  return new Promise(resolve => {
    const back = document.activeElement;
    const box = document.createElement("div");
    box.className = "pc-confirm";
    box.innerHTML = `<form class="pc-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="pcCfT" aria-describedby="pcCfD" novalidate>
      <h3 id="pcCfT">${esc(A.confirm)}${shopName ? ` — ${esc(shopName)}` : ""}</h3>
      ${action === "grant" ? `<label class="pc-f"><span>Plan</span><select name="plan">${paid.map(p => `<option value="${esc(p.code)}">${esc(p.label)} · ${esc(money(p.price))}</option>`).join("")}</select></label>` : ""}
      ${action === "extend" ? `<label class="pc-f"><span>Extend by (days, 1–90)</span><input name="days" type="number" min="1" max="90" step="1" value="7" inputmode="numeric"></label>` : ""}
      <div id="pcCfD" class="pc-conseq" aria-live="polite"></div>
      <label class="pc-f"><span>Reason (kept in the audit log)</span><textarea name="reason" rows="3" maxlength="300" required></textarea></label>
      <p class="pc-msg bad" data-pc-cferr role="alert" hidden></p>
      <div class="pc-formbtns"><button type="button" class="btn sm" data-pc-cancel>Cancel</button>
        <button type="submit" class="btn sm ${A.danger ? "danger solid" : "primary"}" data-pc-go disabled>${esc(A.confirm)}</button></div></form>`;
    host.appendChild(box);
    const form = box.querySelector("form"), out = box.querySelector(".pc-conseq"), errBox = box.querySelector("[data-pc-cferr]"), go = box.querySelector("[data-pc-go]");
    const args = () => (action === "grant" ? { plan: st.plan } : action === "extend" ? { days: st.days } : {});
    const reasonOk = () => String(form.elements.reason.value || "").trim().length >= 3;
    const sync = () => { go.disabled = st.busy || !st.preview || !reasonOk(); };
    const showErr = msg => { errBox.textContent = msg || ""; errBox.hidden = !msg; };
    async function preview(){
      const seq = ++st.seq;
      st.preview = null; sync();
      out.innerHTML = `<p class="note" role="status">Checking what this will do…</p>`;
      try{
        const pv = await P.customerAction(owner, action, { args: args(), dryRun: true });
        if(seq !== st.seq) return;
        st.preview = pv;
        const lines = actionConsequence(action, pv, { day, money });
        out.innerHTML = `<p class="pc-conseq-h">What happens</p><ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`;
      }catch(e){
        if(seq !== st.seq) return;
        out.innerHTML = `<p class="pc-msg bad">${esc((e && e.message) || "This can't be done.")}</p>`;
      }
      sync();
    }
    const done = v => { box.remove(); if(back && back.isConnected && back.focus) back.focus({ preventScroll: true }); resolve(v); };
    box.addEventListener("click", e => { if(e.target.closest && e.target.closest("[data-pc-cancel]") && !st.busy) done(null); });
    box.addEventListener("keydown", e => { if(e.key === "Escape" && !st.busy){ e.stopPropagation(); done(null); } });
    form.addEventListener("input", e => {
      if(e.target.name === "reason"){ showErr(""); sync(); return; }
      if(e.target.name === "days"){
        const n = Math.round(+e.target.value); st.days = Number.isFinite(n) ? n : 0;
        st.preview = null; sync(); clearTimeout(st.timer); st.timer = setTimeout(preview, 300);
      }
    });
    form.addEventListener("change", e => { if(e.target.name === "plan"){ st.plan = e.target.value; preview(); } });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      if(!reasonOk()){ showErr("Give a reason (at least 3 characters)."); form.elements.reason.focus(); return; }
      if(!st.preview || st.busy) return;
      st.busy = true; sync(); go.setAttribute("aria-busy", "true"); showErr("");
      try{
        const r = await P.customerAction(owner, action, { reason: String(form.elements.reason.value).trim(), args: args() });
        done(r);
      }catch(err){
        st.busy = false; go.removeAttribute("aria-busy"); sync();
        showErr((err && err.message) || "Couldn't do it. Nothing changed.");
      }
    });
    (form.elements.plan || form.elements.days || form.elements.reason).focus();
    preview();
  });
}

// Console → Promotions: the plans on sale and the campaigns (promo codes and offers such as the launch offer) with their
// redemption counters and caps. Changing a campaign (promotions.manage) or a plan (plans.manage) goes through the database,
// which checks the role, every value and the hard cap (never below what was redeemed), and writes the audit log.
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { can } from '../../../domain/platform/console.js';
import { count, dateInput, day, endOfDay, errorPanelHTML, loadingHTML, money, msgHTML, startOfDay } from '../services/console-ui.js';

const offerText = c => c.kind === "percent" ? `${+c.value}% off` : c.kind === "price" ? `Plan for ${money(c.value)}` : `${money(c.value)} off`;
const lengthText = p => p.kind === "trial" ? `${count(p.days)} days (free trial)` : `${count(p.months)} month${+p.months === 1 ? "" : "s"}`;

function planRowHTML(p, edit){
  return `<tr><td><b>${esc(p.label)}</b></td><td><code>${esc(p.code)}</code></td><td>${esc(lengthText(p))}</td><td class="num">${esc(money(p.price))}</td>
    <td>${p.active ? "On sale" : "Off"}</td><td class="num">${esc(String(p.sort))}</td>${edit ? `<td><button type="button" class="btn sm" data-pc-edit="plan:${esc(p.code)}">Edit</button></td>` : ""}</tr>`;
}
function planFormHTML(p, span){
  return `<tr class="pc-editrow"><td colspan="${span}"><form class="pc-form" data-pc-form="plan:${esc(p.code)}" novalidate>
    <label class="pc-f"><span>Name</span><input name="label" value="${esc(p.label)}" maxlength="40" required></label>
    <label class="pc-f"><span>Price</span><input name="price" type="number" inputmode="decimal" min="0" step="1" value="${esc(String(+p.price))}" required></label>
    ${p.kind === "trial" ? `<label class="pc-f"><span>Days</span><input name="days" type="number" inputmode="numeric" min="1" max="90" value="${esc(String(p.days))}" required></label>` : ""}
    <label class="pc-f"><span>Order</span><input name="sort" type="number" inputmode="numeric" step="1" value="${esc(String(p.sort))}"></label>
    <label class="pc-check"><input type="checkbox" name="active"${p.active ? " checked" : ""}> On sale</label>
    <div class="pc-formbtns"><button type="submit" class="btn primary sm">Save</button><button type="button" class="btn sm" data-pc-cancel>Cancel</button></div></form></td></tr>`;
}
function campaignRowHTML(c, edit){
  const cap = c.max_uses != null ? `${count(c.redeemed)} of ${count(c.max_uses)}` : `${count(c.redeemed)} (no cap)`;
  return `<tr><td><b>${esc(c.title || c.code)}</b><br><code>${esc(c.code)}</code></td><td>${esc(offerText(c))}</td><td>${esc(Array.isArray(c.plans) && c.plans.length ? c.plans.join(", ") : "All plans")}</td>
    <td class="num">${esc(cap)}${+c.held ? `<br><small>${esc(count(c.held))} at checkout now</small>` : ""}</td>
    <td>${c.starts_at ? esc(day(c.starts_at)) : "Now"} – ${c.ends_at ? esc(day(c.ends_at)) : "no end"}</td>
    <td>${c.active ? `<span class="chip-s ok nodot">Active</span>` : `<span class="chip-s nodot">Off</span>`}${c.auto_apply ? " <small>Applies by itself</small>" : ""}${c.new_customers_only ? " <small>New customers</small>" : ""}</td>
    ${edit ? `<td><button type="button" class="btn sm" data-pc-edit="campaign:${esc(c.code)}">Edit</button></td>` : ""}</tr>`;
}
function campaignFormHTML(c, span){
  return `<tr class="pc-editrow"><td colspan="${span}"><form class="pc-form" data-pc-form="campaign:${esc(c.code)}" novalidate>
    <label class="pc-f"><span>Title</span><input name="title" value="${esc(c.title || "")}" maxlength="60"></label>
    <label class="pc-f"><span>${c.kind === "percent" ? "Percent off" : c.kind === "price" ? "Offer price" : "Amount off"}</span><input name="value" type="number" inputmode="decimal" min="0" step="any" value="${esc(String(+c.value))}" required></label>
    <label class="pc-f"><span>Cap (redemptions)</span><input name="max_uses" type="number" inputmode="numeric" min="${esc(String(c.redeemed || 0))}" step="1" value="${c.max_uses != null ? esc(String(c.max_uses)) : ""}" placeholder="No cap"></label>
    <label class="pc-f"><span>Per shop</span><input name="per_account_limit" type="number" inputmode="numeric" min="1" step="1" value="${esc(String(c.per_account_limit || 1))}"></label>
    <label class="pc-f"><span>Starts</span><input name="starts_at" type="date" value="${esc(dateInput(c.starts_at))}"></label>
    <label class="pc-f"><span>Ends (end of day)</span><input name="ends_at" type="date" value="${esc(dateInput(c.ends_at))}"></label>
    <label class="pc-check"><input type="checkbox" name="active"${c.active ? " checked" : ""}> Active</label>
    <label class="pc-check"><input type="checkbox" name="auto_apply"${c.auto_apply ? " checked" : ""}> Applies by itself (no code)</label>
    <label class="pc-check"><input type="checkbox" name="new_customers_only"${c.new_customers_only ? " checked" : ""}> New customers only</label>
    <div class="pc-formbtns"><button type="submit" class="btn primary sm">Save</button><button type="button" class="btn sm" data-pc-cancel>Cancel</button></div></form></td></tr>`;
}
function pageHTML(d, st, editC, editP){
  const ps = editP ? 7 : 6, cs = editC ? 7 : 6;
  return `<div class="pc-page"><div class="pc-head"><h1>Promotions</h1></div>${msgHTML(st.msg, st.tone)}
    <section class="pc-group" aria-labelledby="pcPlansT"><h2 id="pcPlansT">Plans</h2><div class="pc-table-wrap"><table class="pc-table">
      <thead><tr><th>Plan</th><th>Code</th><th>Length</th><th class="num">Price</th><th>Status</th><th class="num">Order</th>${editP ? '<th><span class="sr">Edit</span></th>' : ""}</tr></thead>
      <tbody>${d.plans.map(p => st.editing === "plan:" + p.code ? planFormHTML(p, ps) : planRowHTML(p, editP)).join("")}</tbody></table></div></section>
    <section class="pc-group" aria-labelledby="pcCampT"><h2 id="pcCampT">Campaigns</h2><div class="pc-table-wrap"><table class="pc-table">
      <thead><tr><th>Campaign</th><th>Offer</th><th>Plans</th><th class="num">Redeemed</th><th>Dates</th><th>Status</th>${editC ? '<th><span class="sr">Edit</span></th>' : ""}</tr></thead>
      <tbody>${d.campaigns.length ? d.campaigns.map(c => st.editing === "campaign:" + c.code ? campaignFormHTML(c, cs) : campaignRowHTML(c, editC)).join("") : `<tr><td colspan="${cs}" class="note">No campaigns.</td></tr>`}</tbody></table></div></section>
  </div>`;
}
/* The form's values as the database takes them (only the fields the form has) */
function patchOf(form, kind){
  const v = n => (form.elements[n] ? String(form.elements[n].value).trim() : undefined), on = n => !!(form.elements[n] && form.elements[n].checked);
  if(kind === "plan"){
    const p = { label: v("label"), price: v("price"), sort: v("sort"), active: on("active") };
    if(form.elements.days) p.days = v("days");
    return p;
  }
  return { title: v("title"), value: v("value"), max_uses: v("max_uses"), per_account_limit: v("per_account_limit"), starts_at: startOfDay(v("starts_at")), ends_at: endOfDay(v("ends_at")),
    active: on("active"), auto_apply: on("auto_apply"), new_customers_only: on("new_customers_only") };
}

export async function renderPromotions(main, { me }){
  main.innerHTML = loadingHTML("Promotions");
  const P = use("platform");
  let data;
  try{ data = await P.promotions(); }catch(e){ main.innerHTML = errorPanelHTML("Promotions", e); return; }
  const editC = can(me.perms, "promotions.manage"), editP = can(me.perms, "plans.manage"), st = { editing: null, msg: "", tone: "" };
  const draw = () => { main.innerHTML = pageHTML(data, st, editC, editP); const f = main.querySelector("[data-pc-form] input"); if(f) f.focus(); };
  draw();
  main.onclick = e => {
    const ed = e.target.closest && e.target.closest("[data-pc-edit]");
    if(ed){ st.editing = ed.dataset.pcEdit; st.msg = ""; draw(); return; }
    if(e.target.closest && e.target.closest("[data-pc-cancel]")){ st.editing = null; draw(); }
  };
  main.onsubmit = async e => {
    const form = e.target.closest && e.target.closest("[data-pc-form]");
    if(!form) return;
    e.preventDefault();
    const [kind, code] = form.dataset.pcForm.split(":");
    form.querySelectorAll("input,button").forEach(x => { x.disabled = true; });
    try{
      if(kind === "plan") await P.savePlan(code, patchOf(form, "plan"));
      else await P.saveCampaign(code, patchOf(form, "campaign"));
      data = await P.promotions();
      st.editing = null; st.msg = "Saved. The change is in the audit log."; st.tone = "ok";
    }catch(err){ st.msg = (err && err.message) || "Couldn't save."; st.tone = "bad"; }
    draw();
  };
}

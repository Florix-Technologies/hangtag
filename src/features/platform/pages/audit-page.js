// Console → Audit Log: every privileged action in the console (sign-ins, attempts without a role, changes to campaigns,
// plans, Hangtag's settings and console access), newest first, with who did it and what changed — written by the
// database's console functions themselves (hangtag_platform_audit), never by the browser.
import { use } from '../../../shared/di/services.js';
import { esc } from '../../../shared/dom.js';
import { ROLE_LABELS, auditChanges, auditLabel } from '../../../domain/platform/console.js';
import { errorPanelHTML, loadingHTML, when } from '../services/console-ui.js';

const PAGE = 50;
const rowHTML = a => `<tr${a.ok ? "" : ' class="pc-bad"'}><td class="nowrap">${esc(when(a.t))}</td><td>${esc(a.actor_email || (a.actor ? a.actor.slice(0, 8) + "…" : "System"))}${a.actor_role ? `<br><small>${esc(ROLE_LABELS[a.actor_role] || a.actor_role)}</small>` : ""}</td>
  <td>${esc(auditLabel(a.action))}</td><td>${a.target_id ? `<code>${esc(a.target_id)}</code>` : "—"}</td>
  <td>${auditChanges(a.detail).map(c => `<div>${esc(c)}</div>`).join("") || "—"}</td></tr>`;

export async function renderAudit(main){
  main.innerHTML = loadingHTML("Audit Log");
  const P = use("platform");
  let rows;
  try{ rows = await P.audit(PAGE, null); }catch(e){ main.innerHTML = errorPanelHTML("Audit Log", e); return; }
  let more = rows.length === PAGE;
  const draw = () => {
    main.innerHTML = `<div class="pc-page"><div class="pc-head"><h1>Audit Log</h1><span class="note">Privileged actions in the console, newest first</span></div>
      <div class="pc-table-wrap"><table class="pc-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>What changed</th></tr></thead>
      <tbody>${rows.length ? rows.map(rowHTML).join("") : '<tr><td colspan="5" class="note">Nothing yet.</td></tr>'}</tbody></table></div>
      ${more ? '<p><button type="button" class="btn sm" data-pc-older>Older entries</button></p>' : ""}</div>`;
  };
  draw();
  main.onclick = async e => {
    if(!(e.target.closest && e.target.closest("[data-pc-older]"))) return;
    try{ const older = await P.audit(PAGE, rows[rows.length - 1].id); rows = rows.concat(older); more = older.length === PAGE; draw(); }
    catch(err){ main.insertAdjacentHTML("beforeend", errorPanelHTML("", err)); }
  };
}

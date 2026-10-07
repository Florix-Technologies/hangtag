// Settings → Advanced → Diagnostics & health: is this device healthy (online, the cloud, uploads waiting or refused, the
// app's service worker and build), how fast the server answers (every call's time over 24 hours, by operation), the Agent's
// chains (each question: request → tools → result → action → approval → outcome), and the recent technical problems from
// the privacy-safe history kept on this device (shared/logging/diagnostics.js: no customer, bill or money details, no
// tokens, no web addresses, never a question's words). Copy or download the report for support; nothing is sent anywhere
// by itself.
import { DIAG_CATEGORIES, categoryCounts, clearDiagnostics, clearLatency, clearTraces, diagnosticsReport, diagnosticsSummary, getDiagnostics, getTraces, latencySummary } from '../../../shared/logging/diagnostics.js';
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { $, esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { agoText, dayKey } from '../../../shared/formatting/dates.js';
import { moduleShown } from '../services/modules.js';

let build = "";
/* The app's build: the name of the service worker's cache ("hangtag-<hash>"), found once */
async function findBuild(){
  try{ const keys = (await caches.keys()).filter(k => /^hangtag-[0-9a-f]+$/.test(k)).sort(); build = keys.pop() || "not cached"; }catch{ build = "unknown"; }
  const el = $("#diagBuild"); if(el) el.textContent = build;
}
/* What the report says about this device right now */
export function healthNow(){
  const sw = typeof navigator !== "undefined" && "serviceWorker" in navigator ? (navigator.serviceWorker.controller ? "active" : "not-active") : "unsupported";
  return { online: typeof navigator === "undefined" ? true : navigator.onLine, cloud: store.sbStatus || "local", pending: (store.sbOfflineQueue || []).length,
    review: (store.syncReview || []).length, serviceWorker: sw, build: build || "unknown" };
}
const CLOUD_WORDS = { connected: "Connected", connecting: "Connecting", error: "Not reachable", update: "Database update needed", local: "On this device only", off: "Off" };
const moduleShownAgent = () => { try{ return moduleShown("assistant"); }catch{ return false; } };
const row = (label, value, tone) => `<div class="diag-kv${tone ? " " + tone : ""}"><span>${esc(label)}</span><b>${value}</b></div>`;

export function diagnosticsHTML(){
  const H = healthNow(), S = diagnosticsSummary(), list = getDiagnostics().slice(-20).reverse();
  if(!build) setTimeout(findBuild, 0);
  const oldest = (store.sbOfflineQueue || []).reduce((t, q) => Math.min(t, +q.t || Infinity), Infinity);
  const health = row("Internet", H.online ? "Online" : "Offline", H.online ? "" : "warn")
    + row("Cloud", esc(CLOUD_WORDS[H.cloud] || H.cloud), H.cloud === "connected" || H.cloud === "local" ? "" : "warn")
    + row("Changes waiting to upload", `${H.pending}${H.pending && Number.isFinite(oldest) ? ` · oldest ${esc(agoText(oldest))}` : ""}`, H.pending > 20 ? "warn" : "")
    + row("Refused by the database", String(H.review), H.review ? "bad" : "")
    + row("Last full sync", store.lastSyncAt ? esc(agoText(store.lastSyncAt)) : "—")
    + row("Works offline (service worker)", H.serviceWorker === "active" ? "Yes" : H.serviceWorker === "unsupported" ? "Not supported here" : "Not yet", H.serviceWorker === "active" ? "" : "warn")
    + `<div class="diag-kv"><span>App build</span><b id="diagBuild">${esc(build || "…")}</b></div>`;
  const C = categoryCounts(24), total = Object.values(C).reduce((a, b) => a + b, 0);
  const cats = `<h6 class="diag-h">Last 24 hours <span class="note">${total ? total + " event" + (total === 1 ? "" : "s") : "nothing noted"}</span></h6>
    <div class="diag-cats">${Object.entries(DIAG_CATEGORIES).map(([k, label]) => `<div class="diag-cat${C[k] ? " on" : ""}" data-diag-cat="${esc(k)}" title="${esc(k === "api" ? "Calls to the Hangtag server that were slow or failed" : label)}"><span>${esc(label)}</span><b>${C[k]}</b></div>`).join("")}</div>`;
  // server calls: every call's time, by operation (the busiest first)
  const Lt = latencySummary(24), ms = n => n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
  const latency = `<h6 class="diag-h">Server calls · last 24 hours <span class="note">${Lt.calls ? `${Lt.calls} call${Lt.calls === 1 ? "" : "s"} · ${Lt.failed} failed · typical ${ms(Lt.avgMs)}${Lt.slow ? ` · ${Lt.slow} slow (3 s or more)` : ""}` : "none yet on this device"}</span></h6>
    ${Lt.ops.length ? `<table class="diag-lat"><thead><tr><th>Operation</th><th>Calls</th><th>Failed</th><th>Average</th><th>Most within</th><th>Slowest</th></tr></thead><tbody>${Lt.ops.slice(0, 10).map(o => `<tr data-lat-op="${esc(o.op)}"${o.failed || o.slow ? ' class="warn"' : ""}><td>${esc(o.op)}</td><td>${o.calls}</td><td>${o.failed}</td><td>${ms(o.avgMs)}</td><td>${esc(o.p95)}</td><td>${ms(o.maxMs)}</td></tr>`).join("")}</tbody></table>` : ""}`;
  // the Agent's chains: the latest questions, each step in order (codes only)
  const STEP_WORDS = { request: "asked", tool: "tool", result: "result", action: "opened", approval: "", outcome: "" };
  const chain = t => t.steps.map(s => `<span class="dg-step ${s.ok ? "" : "bad"}" data-step="${esc(s.step)}">${esc([STEP_WORDS[s.step], s.op].filter(Boolean).join(" "))}${s.step === "result" ? ` · ${s.count || 0} row${s.count === 1 ? "" : "s"}` : ""}${s.code ? ` · ${esc(s.code)}` : ""}${s.time && (s.step === "tool" || s.step === "request" && s.op === "provider") ? ` · ${esc(s.time)}` : ""}</span>`).join('<span class="dg-arrow">→</span>');
  const T = getTraces().slice(-5).reverse();
  const traces = moduleShownAgent() ? `<h6 class="diag-h">Agent chain <span class="note">${T.length ? "the latest questions: request → tool → result → action → approval → outcome" : "no questions yet on this device"}</span></h6>
    ${T.length ? `<ol class="diag-chains">${T.map(t => `<li data-trace="${esc(t.id)}"><span class="dg-when">${esc(new Date(t.at).toLocaleTimeString())} · ${esc(t.source)}</span><span class="dg-chain">${chain(t)}</span></li>`).join("")}</ol>` : ""}` : "";
  const problems = list.length ? `<ol class="diag-list">${list.map(e => `<li class="${esc(e.level)}" data-diag-entry><span class="dg-when">${esc(dayKey(Date.parse(e.at)) === dayKey(Date.now()) ? new Date(e.at).toLocaleTimeString() : e.at.slice(0, 10))}</span><span class="dg-what"><b>${esc(e.level === "warn" ? "Warning" : e.level === "info" ? "Note" : "Problem")}</b>${e.count > 1 ? ` <span class="dg-count">×${e.count}</span>` : ""} · ${esc(e.message)}${e.file ? `<small>${esc(e.file)}${e.line ? ":" + e.line : ""}${e.code ? " · " + esc(e.code) : ""}${e.status ? " · " + e.status : ""}</small>` : ""}</span></li>`).join("")}</ol>`
    : `<p class="note" style="margin:0">No technical problems recorded on this device.</p>`;
  return `<div class="setblk" id="diagBlk"><h5>Diagnostics &amp; health</h5><p class="note" style="margin:0 0 10px">How this device is doing, and the technical problems it noticed lately. Kept on this device only, without customer, bill or money details — copy or download it when support asks.</p>
    <p class="note diag-private" style="margin:0 0 10px">Never sent anywhere by itself: nothing leaves this device unless you copy or download the report.</p>
    <div class="diag-health">${health}</div>${cats}${latency}${traces}
    <h6 class="diag-h">Recent problems <span class="note">${S.errors} problem${S.errors === 1 ? "" : "s"} · ${S.warnings} warning${S.warnings === 1 ? "" : "s"}</span></h6>${problems}
    <div class="btnrow" style="margin-top:12px"><button class="btn" type="button" data-diag="copy">Copy report</button><button class="btn" type="button" data-diag="download">Download report</button>${list.length || Lt.calls || T.length ? `<button class="btn" type="button" data-diag="clear">Clear</button>` : ""}</div></div>`;
}

const reportText = () => JSON.stringify(diagnosticsReport(healthNow()), null, 2);
let installed = false;
export function installDiagnosticsEvents(){
  if(installed) return; installed = true;
  document.addEventListener("click", async e => {
    const b = e.target && e.target.closest ? e.target.closest("[data-diag]") : null; if(!b) return;
    e.preventDefault();
    const what = b.dataset.diag;
    if(what === "copy"){ try{ await navigator.clipboard.writeText(reportText()); toast("Diagnostics report copied."); }catch{ toast("Couldn't copy here. Use Download report."); } return; }
    if(what === "download"){ const ok = await use("files").saveFile(`hangtag-diagnostics-${dayKey(Date.now())}.json`, reportText(), "application/json"); if(ok) toast("Diagnostics report saved."); return; }
    if(what === "clear"){
      // asked on the button itself (no browser pop-up): a second tap within 5 seconds clears
      if(b.dataset.armed !== "1"){ b.dataset.armed = "1"; b.textContent = "Tap again to clear"; b.classList.add("danger"); setTimeout(() => { if(b.isConnected){ b.dataset.armed = ""; b.textContent = "Clear"; b.classList.remove("danger"); } }, 5000); return; }
      clearDiagnostics(); clearLatency(); clearTraces(); renderAll(); toast("Diagnostics cleared.");
    }
  });
}

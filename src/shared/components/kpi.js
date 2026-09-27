// KPI tile markup.
import { ICON } from '../constants/icons.js';
import { esc } from '../dom.js';

/* ================= stock ================= */

export function kpi(l,v,sub,st){return `<div class="kpi ${st||""}"><div class="lab">${st==="warn"?ICON.warn:st==="crit"?ICON.out:""}${esc(l)}</div><div class="val">${esc(v)}</div>${sub?`<div class="kps">${sub}</div>`:""}</div>`}

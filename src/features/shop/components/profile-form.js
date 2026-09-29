// Shop profile form fields and reading them.
import { PROFILE_FIELDS } from '../../../domain/shop/profile.js';
import { checkProfile, tidyProfile } from '../../../domain/shop/profile-validation.js';
import { businessKind } from '../../../domain/shop/capabilities.js';
import { esc } from '../../../shared/dom.js';

/* opts.needType: shop setup — the type of business must be chosen (settings show the current one, retail when none) */
export function profileFieldsHTML(p, prefix, opts){
  p = p || {};
  const needType = !!(opts && opts.needType);
  return '<div class="pgrid">' + PROFILE_FIELDS.map(f => {
    const id = prefix + "_" + f.k, req = f.req || (f.needType && needType);
    let v = p[f.k] == null ? "" : String(p[f.k]);
    if(f.needType && (v || !needType)) v = businessKind(v);   // older profiles ("Clothing boutique" …) show as retail
    const lab = '<span class="lab">' + esc(f.label) + (req ? '<span class="req" aria-hidden="true">*</span>' : "") + "</span>";
    let input;
    if(f.select){
      input = '<select id="' + id + '" name="' + f.k + '"' + (req ? " required" : "") + ">" + (v ? "" : '<option value="">Choose…</option>') +
        f.select.map(o => { const val = typeof o === "string" ? o : o.value, l = typeof o === "string" ? o : o.label; return '<option value="' + esc(val) + '"' + (val === v ? " selected" : "") + ">" + esc(l) + "</option>"; }).join("") + "</select>";
    } else {
      input = '<input id="' + id + '" name="' + f.k + '" type="' + (f.type || "text") + '" value="' + esc(v) + '"' +
        (f.ac ? ' autocomplete="' + f.ac + '"' : "") + (f.im ? ' inputmode="' + f.im + '"' : "") +
        (f.max ? ' maxlength="' + f.max + '"' : "") + (f.req ? " required" : "") + (f.upper ? ' autocapitalize="characters"' : "") + ">";
    }
    const hint = f.needType ? (needType ? "Sets up Hangtag for your kind of shop. You can change it any time in Settings." : "Changing it switches on what's recommended for that kind of shop (Capabilities below).") : f.hint;
    return '<label class="f' + (f.full ? " full" : "") + '" data-field="' + f.k + '">' + lab + input + (hint ? '<span class="fhint">' + esc(hint) + "</span>" : "") + "</label>";
  }).join("") + "</div>";
}
/* Read and check the form. Returns { values } or { error, field }. opts.needType as above. */

export function readProfileForm(form, opts){
  const raw = {};
  PROFILE_FIELDS.forEach(f => { const el = form.querySelector('[name="' + f.k + '"]'); raw[f.k] = el ? el.value : ""; });
  const out = tidyProfile(raw);
  form.querySelectorAll(".f.bad").forEach(x => x.classList.remove("bad"));
  const problem = checkProfile(out, opts);
  if(problem){
    const w = form.querySelector('[data-field="' + problem.field + '"]');
    if(w){ w.classList.add("bad"); const i = w.querySelector("input,select"); if(i) i.focus(); }
    return problem;
  }
  return { values: out };
}

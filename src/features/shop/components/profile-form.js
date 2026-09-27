// Shop profile form fields and reading them.
import { PROFILE_FIELDS } from '../../../domain/shop/profile.js';
import { checkProfile, tidyProfile } from '../../../domain/shop/profile-validation.js';
import { esc } from '../../../shared/dom.js';

export function profileFieldsHTML(p, prefix){
  p = p || {};
  return '<div class="pgrid">' + PROFILE_FIELDS.map(f => {
    const id = prefix + "_" + f.k, v = p[f.k] == null ? "" : String(p[f.k]);
    const lab = '<span class="lab">' + esc(f.label) + (f.req ? '<span class="req" aria-hidden="true">*</span>' : "") + "</span>";
    let input;
    if(f.select){
      input = '<select id="' + id + '" name="' + f.k + '"><option value="">Choose…</option>' +
        f.select.map(o => '<option' + (o === v ? " selected" : "") + ">" + esc(o) + "</option>").join("") + "</select>";
    } else {
      input = '<input id="' + id + '" name="' + f.k + '" type="' + (f.type || "text") + '" value="' + esc(v) + '"' +
        (f.ac ? ' autocomplete="' + f.ac + '"' : "") + (f.im ? ' inputmode="' + f.im + '"' : "") +
        (f.max ? ' maxlength="' + f.max + '"' : "") + (f.req ? " required" : "") + (f.upper ? ' autocapitalize="characters"' : "") + ">";
    }
    return '<label class="f' + (f.full ? " full" : "") + '" data-field="' + f.k + '">' + lab + input + (f.hint ? '<span class="fhint">' + esc(f.hint) + "</span>" : "") + "</label>";
  }).join("") + "</div>";
}
/* Read and check the form. Returns { values } or { error, field }. */

export function readProfileForm(form){
  const raw = {};
  PROFILE_FIELDS.forEach(f => { const el = form.querySelector('[name="' + f.k + '"]'); raw[f.k] = el ? el.value : ""; });
  const out = tidyProfile(raw);
  form.querySelectorAll(".f.bad").forEach(x => x.classList.remove("bad"));
  const problem = checkProfile(out);
  if(problem){
    const w = form.querySelector('[data-field="' + problem.field + '"]');
    if(w){ w.classList.add("bad"); const i = w.querySelector("input,select"); if(i) i.focus(); }
    return problem;
  }
  return { values: out };
}

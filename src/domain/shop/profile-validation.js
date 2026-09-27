// Shop profile rules: tidy the values and check them (the same for setup and settings).
import { PROFILE_FIELDS } from './profile.js';
import { validGstin } from '../../shared/validation/gstin.js';
import { validPhone } from '../../shared/validation/phone.js';

/* Trim and tidy raw form values ({ field: string }); empty becomes null, GST number upper case without spaces */
export function tidyProfile(raw){
  const out={};
  PROFILE_FIELDS.forEach(f=>{
    let v=String(raw[f.k]==null?"":raw[f.k]).trim().replace(/\s+/g," ");
    if(f.upper)v=v.toUpperCase().replace(/\s/g,"");
    out[f.k]=v||null;
  });
  return out;
}
/* The first problem as { error, field }, or null when the profile can be saved */
export function checkProfile(values){
  for(const f of PROFILE_FIELDS){ if(f.req && !values[f.k]) return { error: f.label + " is required.", field: f.k }; }
  if(!validPhone(values.phone)) return { error: "Enter a valid phone number (at least 10 digits).", field: "phone" };
  if(values.gstin && !validGstin(values.gstin)) return { error: "GST number should be 15 letters and digits, like 27ABCDE1234F1Z5.", field: "gstin" };
  return null;
}

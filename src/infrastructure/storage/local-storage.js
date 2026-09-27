// The "storage" port over localStorage: JSON values (never throw) and raw strings (throw like localStorage does).

export const LS={
  get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch(e){return false}},
  getRaw:k=>localStorage.getItem(k),
  setRaw:(k,v)=>localStorage.setItem(k,v),
  remove:k=>localStorage.removeItem(k)
};

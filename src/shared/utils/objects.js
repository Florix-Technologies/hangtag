// Small object helpers.

export const objOr=(v,d)=>(v&&typeof v==="object"&&!Array.isArray(v))?v:d;

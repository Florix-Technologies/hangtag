// Ports registry: app/container.js provides an implementation for each port (contracts in ./ports.js); code that needs one calls use(name).
const impls = new Map();

export function provide(name, impl){ impls.set(name, impl); return impl; }
/* Looked up on every call, so a port replaced later (a test fake) is the one used */
export function use(name){
  const impl = impls.get(name);
  if(!impl) throw new Error(`Nothing is provided for the "${name}" port. app/container.js provides the ports at start-up; unit tests provide fakes with override().`);
  return impl;
}
/* Unit tests: override({ storage: fake }) swaps in fakes and returns a function that puts the previous ones back */
export function override(fakes){
  const saved = new Map(impls);
  Object.entries(fakes).forEach(([name, impl]) => impls.set(name, impl));
  return () => { impls.clear(); saved.forEach((impl, name) => impls.set(name, impl)); };
}
export function resetPorts(){ impls.clear(); }

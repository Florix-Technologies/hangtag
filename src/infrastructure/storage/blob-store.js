// The "blobStore" port: files kept on this device (IndexedDB) — a supplier bill's original photo or PDF is kept here from
// the moment it is chosen until the cloud has it, so a failed reading, a closed tab or no internet never loses it.
// get(key) → { blob, name, type, t } | null · put(key, { blob, name, type }) · remove(key) · keys()
const DB = "hangtag-files", STORE = "files";

export function createBlobStore(){
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((ok, fail) => {
    if(typeof indexedDB === "undefined"){ fail(new Error("This browser can't keep files.")); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if(!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { dbp = null; fail(r.error || new Error("Couldn't open the file store.")); };
  }));
  const run = (mode, fn) => open().then(db => new Promise((ok, fail) => {
    const tx = db.transaction(STORE, mode), st = tx.objectStore(STORE), req = fn(st);
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = () => fail(tx.error || new Error("File store error"));
    tx.onabort = () => fail(tx.error || new Error("File store error"));
  }));
  return {
    put: (key, { blob, name, type }) => run("readwrite", st => st.put({ blob, name: name || "", type: type || (blob && blob.type) || "", t: Date.now() }, key)),
    get: key => run("readonly", st => st.get(key)).then(v => v || null),
    remove: key => run("readwrite", st => st.delete(key)),
    keys: () => run("readonly", st => st.getAllKeys()).then(v => v || []),
  };
}

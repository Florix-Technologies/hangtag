// Service worker registration and persistent storage request.

/* Registered once at start-up (app/main.js). */
export function installPwa(){
  /* ================= boot ================= */

  if("serviceWorker" in navigator&&location.protocol==="https:"){
    window.addEventListener("load",()=>{navigator.serviceWorker.register("sw.js").catch(()=>{})});
  }
  if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(()=>{});
}

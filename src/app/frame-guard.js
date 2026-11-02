// Clickjacking: the shop app and the Platform Console never run inside another site's frame. Where the host sends HTTP
// headers (vercel.json: frame-ancestors 'none', X-Frame-Options DENY) the browser refuses already; a host that sends none
// (a static file host) leaves only this check, made before anything boots. The app's own pages may still frame each other.
import { esc } from '../shared/dom.js';

/* Is this page inside a frame of another site? (reading a cross-site parent's address throws) */
export function framedByAnotherSite(win = typeof window !== "undefined" ? window : null){
  if(!win || win.top === win.self) return false;
  try{ return win.top.location.origin !== win.location.origin; }
  catch{ return true; }
}
/* If so: the page says why it won't open here, with a way to open it on its own — and the caller stops */
export function refuseFraming(win = typeof window !== "undefined" ? window : null){
  if(!framedByAnotherSite(win)) return false;
  const doc = win.document, href = win.location.href;
  doc.body.innerHTML = `<main style="font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px">
    <h1 style="font-size:20px">Hangtag can't open inside another website</h1>
    <p>For your shop's safety, Hangtag only works in its own tab.</p>
    <p><a href="${esc(href)}" target="_blank" rel="noopener">Open Hangtag in a new tab</a></p></main>`;
  return true;
}

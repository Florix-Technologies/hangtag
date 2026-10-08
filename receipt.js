// The page behind a secure invoice link (https://…/receipt.html#<token>): asks the "receipt" Edge Function for that one
// bill and shows it. The token stays after "#", so it isn't sent to this site's server. Everything shown is set as text.
// Line amounts are written by the app's one money formatter (src/shared/formatting/money.js); the totals come written by
// the receipt function.
import { inrx } from './src/shared/formatting/money.js';
(function(){
  "use strict";
  var box = document.getElementById("inv");
  var cfg = window.HANGTAG_CONFIG || {};
  var token = decodeURIComponent((location.hash || "").slice(1));
  function el(tag, cls, text){ var e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
  function fail(msg){ box.textContent = ""; box.appendChild(el("h1", "", "Invoice")); box.appendChild(el("p", "muted", msg)); }
  if(!/^[A-Za-z0-9_-]{32,64}$/.test(token)){ fail("This invoice link is incomplete. Open the full link from your message."); return; }
  if(!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY){ fail("This page isn't set up yet."); return; }
  fetch(String(cfg.SUPABASE_URL).replace(/\/+$/, "") + "/functions/v1/receipt", {
    method: "POST", headers: { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY, Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY }, body: JSON.stringify({ token: token })
  }).then(function(r){ return r.json().catch(function(){ return {}; }); }).then(function(d){
    if(!d || !d.ok || !d.bill){ fail((d && d.message) || "This invoice link isn't valid any more. Ask the shop for a new one."); return; }
    var B = d.bill;
    document.title = B.title + " " + B.number + " · " + B.shop;
    box.textContent = "";
    if(d.logo){ var img = el("img", "logo logo-" + (d.logoAlign === "center" || d.logoAlign === "right" ? d.logoAlign : "left")); img.src = d.logo; img.alt = ""; box.appendChild(img); }
    box.appendChild(el("h1", "", B.shop));
    (B.contact || []).forEach(function(c){ box.appendChild(el("div", "muted", c)); });
    if(d.cancelled) box.appendChild(el("div", "void", "CANCELLED"));
    box.appendChild(el("p", "", B.title + " " + B.number + " · " + B.date + (B.customer ? " · " + B.customer : "")));
    var t = el("table");
    (B.lines || []).forEach(function(l){
      var tr = el("tr"), a = el("td"); a.appendChild(el("div", "", l.name));
      if(l.detail) a.appendChild(el("div", "sub", l.detail));
      if(l.discount) a.appendChild(el("div", "sub", "Discount −" + inrx(l.discount)));
      tr.appendChild(a); tr.appendChild(el("td", "r", l.qty + " × " + inrx(l.rate))); tr.appendChild(el("td", "r", inrx(l.gross))); t.appendChild(tr);
    });
    if(B.more){ var m = el("tr"), c = el("td", "sub", "… and " + B.more + " more items"); c.colSpan = 3; m.appendChild(c); t.appendChild(m); }
    box.appendChild(t);
    var s = el("table");
    (B.rows || []).forEach(function(r){ var tr = el("tr", r[2] ? "tot" : ""); tr.appendChild(el("td", "", r[0])); tr.appendChild(el("td", "r", r[1])); s.appendChild(tr); });
    box.appendChild(s);
    box.appendChild(el("p", "foot", "This link shows only this invoice. Issued by " + B.shop + " with Hangtag."));
    var p = el("button", "", "Print or save as PDF"); p.type = "button"; p.onclick = function(){ window.print(); }; box.appendChild(p);
  }).catch(function(){ fail("The invoice couldn't be loaded. Check your internet connection and try again."); });
})();

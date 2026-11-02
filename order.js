// The page behind a table's QR code (https://…/order.html#t=<token>): the shop's menu, a cart, and "Place order" — the
// order reaches the shop's tables and kitchen for that table. The token identifies the shop's table and nothing else; the
// page talks to two public database functions (hangtag_table_menu, hangtag_place_table_order) with the project's
// publishable key, never with a password, a service key or a sign-in. Everything shown is set as text. Money is written by
// the app's one formatter (src/shared/formatting/money.js).
import { inrx } from './src/shared/formatting/money.js';
(function(){
  "use strict";
  var app = document.getElementById("app");
  var cfg = window.HANGTAG_CONFIG || {};
  var m = /(?:^|[#&])t=([A-Za-z0-9_-]{32,64})/.exec(location.hash || "");
  var token = m ? m[1] : "";
  var menu = null, cart = {}, notes = {}, cat = "", q = "", guestName = "", guestNote = "", view = "menu", placing = false, placed = null, error = "";
  function el(tag, cls, text){ var e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
  function btn(text, cls, on){ var b = el("button", cls || "", text); b.type = "button"; b.onclick = on; return b; }
  function rupees(n){ return inrx(Math.round(n * 100) / 100); }
  function fail(msg){ app.textContent = ""; var c = el("div", "card"); c.appendChild(el("h1", "", "Order")); c.appendChild(el("p", "muted", msg)); app.appendChild(c); }
  if(!token){ fail("This QR link is incomplete. Scan the QR code on your table again."); return; }
  if(!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY){ fail("This page isn't set up yet."); return; }
  function rpc(fn, body){
    return fetch(String(cfg.SUPABASE_URL).replace(/\/+$/, "") + "/rest/v1/rpc/" + fn, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY }, body: JSON.stringify(body)
    }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){ return { ok: r.ok, data: d }; }); });
  }
  function itemById(v){ return (menu.items || []).find(function(i){ return i.v === v; }); }
  function count(){ return Object.keys(cart).reduce(function(a, k){ return a + cart[k]; }, 0); }
  function total(){ return Object.keys(cart).reduce(function(a, k){ var i = itemById(k); return a + (i ? i.price * cart[k] : 0); }, 0); }
  function stepper(v){
    var s = el("span", "step"), n = cart[v] || 0;
    s.appendChild(btn("−", "", function(){ if(cart[v] > 1) cart[v]--; else delete cart[v]; render(); }));
    s.appendChild(el("b", "", String(n)));
    s.appendChild(btn("+", "", function(){ if((cart[v] || 0) < 50) cart[v] = (cart[v] || 0) + 1; render(); }));
    return s;
  }
  function header(){
    var h = el("div", "head");
    h.appendChild(el("h1", "", menu.shop || "Menu"));
    h.appendChild(el("span", "tbl", "Table " + (menu.table || "")));
    if(!menu.ordering) h.appendChild(el("p", "muted", "Ordering from your phone isn't available here: please order with the staff."));
    return h;
  }
  function renderMenu(){
    app.appendChild(header());
    var cats = (menu.categories || []);
    if(cats.length){
      var cs = el("div", "cats");
      [""].concat(cats).forEach(function(c){ var b = btn(c || "All", "", function(){ cat = c; render(); }); b.setAttribute("aria-pressed", String(cat === c)); cs.appendChild(b); });
      app.appendChild(cs);
    }
    var s = el("div", "search"), inp = el("input"); inp.type = "search"; inp.placeholder = "Search the menu"; inp.value = q;
    inp.oninput = function(){ q = inp.value; var pos = inp.selectionStart; render(); var i = app.querySelector(".search input"); if(i){ i.focus(); try{ i.setSelectionRange(pos, pos); }catch(e){ /* not a text box */ } } };
    s.appendChild(inp); app.appendChild(s);
    var words = q.toLowerCase().split(/\s+/).filter(Boolean), shown = 0;
    (menu.items || []).forEach(function(i){
      if(cat && i.cat !== cat) return;
      var text = (i.name + " " + (i.vl || "") + " " + (i.cat || "")).toLowerCase();
      if(!words.every(function(w){ return text.indexOf(w) > -1; })) return;
      shown++;
      var row = el("div", "item"), a = el("div");
      a.appendChild(el("b", "", i.name)); if(i.vl) a.appendChild(el("small", "", i.vl)); a.appendChild(el("span", "p", rupees(i.price)));
      row.appendChild(a);
      row.appendChild(menu.ordering ? (cart[i.v] ? stepper(i.v) : btn("Add", "", function(){ cart[i.v] = 1; render(); })) : el("span"));
      app.appendChild(row);
    });
    if(!shown) app.appendChild(el("p", "muted", "Nothing matches."));
  }
  function renderCart(){
    app.appendChild(header());
    var c = el("div", "card"); c.appendChild(el("h1", "", "Your order"));
    Object.keys(cart).forEach(function(v){
      var i = itemById(v); if(!i) return;
      var l = el("div", "line"), a = el("div");
      a.appendChild(el("b", "", i.name)); if(i.vl) a.appendChild(el("small", "muted", " " + i.vl));
      var n = el("input"); n.placeholder = "Note (optional)"; n.maxLength = 120; n.value = notes[v] || ""; n.oninput = function(){ notes[v] = n.value; };
      a.appendChild(n); l.appendChild(a); l.appendChild(stepper(v)); c.appendChild(l);
    });
    if(!count()) c.appendChild(el("p", "muted", "Nothing in your order yet."));
    app.appendChild(c);
    var d = el("div", "card");
    d.appendChild(el("label", "", "Your name (optional)")); var nm = el("input"); nm.id = "gname"; nm.maxLength = 60; nm.value = guestName; nm.oninput = function(){ guestName = nm.value; }; d.appendChild(nm);
    d.appendChild(el("label", "", "Anything else for the kitchen? (optional)")); var no = el("textarea"); no.id = "gnote"; no.maxLength = 200; no.rows = 2; no.value = guestNote; no.oninput = function(){ guestNote = no.value; }; d.appendChild(no);
    if(error) d.appendChild(el("p", "bad", error));
    app.appendChild(d);
  }
  function renderPlaced(){
    app.appendChild(header());
    var c = el("div", "card");
    c.appendChild(el("h1", "ok", "Order sent"));
    c.appendChild(el("p", "", "The kitchen has your order " + (placed.order_no || "") + ". The staff will bring it to your table."));
    c.appendChild(btn("Order something else", "pri", function(){ placed = null; view = "menu"; render(); }));
    app.appendChild(c);
  }
  function bar(){
    var b = el("div", "bar"), i = el("div", "in");
    if(view === "menu"){
      i.appendChild(el("span", "", count() ? count() + " item" + (count() === 1 ? "" : "s") + " · " + rupees(total()) : "Tap Add on what you'd like"));
      var go = btn("View order", "pri", function(){ view = "cart"; error = ""; render(); }); go.disabled = !count(); i.appendChild(go);
    } else {
      i.appendChild(btn("Back to menu", "", function(){ view = "menu"; render(); }));
      var pl = btn(placing ? "Sending…" : "Place order · " + rupees(total()), "pri", place); pl.disabled = placing || !count(); i.appendChild(pl);
    }
    b.appendChild(i); return b;
  }
  function render(){
    app.textContent = "";
    if(placed) renderPlaced(); else if(view === "cart") renderCart(); else renderMenu();
    if(!placed && menu.ordering) app.appendChild(bar());
  }
  function place(){
    if(placing || !count()) return;
    var items = Object.keys(cart).map(function(v){ var x = { v: v, q: cart[v] }; if(notes[v]) x.note = String(notes[v]).slice(0, 120); return x; });
    var nm = document.getElementById("gname"), no = document.getElementById("gnote");
    guestName = nm && nm.value || guestName; guestNote = no && no.value || guestNote;
    placing = true; error = ""; render();
    rpc("hangtag_place_table_order", { p_token: token, p_items: items, p_note: guestNote || null, p_name: guestName || null }).then(function(r){
      placing = false;
      if(!r.ok || !r.data || !r.data.ok){ error = (r.data && r.data.message) || "Your order couldn't be sent. Please ask the staff."; render(); return; }
      placed = r.data; cart = {}; notes = {}; guestName = ""; guestNote = ""; render();
    }).catch(function(){ placing = false; error = "Your order couldn't be sent: check your internet connection and try again."; render(); });
  }
  rpc("hangtag_table_menu", { p_token: token }).then(function(r){
    if(!r.ok || !r.data || !r.data.ok){ fail((r.data && r.data.message) || "This table's QR code isn't valid any more. Please ask the staff."); return; }
    menu = r.data; document.title = (menu.shop || "Menu") + " · Table " + (menu.table || ""); render();
  }).catch(function(){ fail("The menu couldn't be loaded. Check your internet connection and try again."); });
})();

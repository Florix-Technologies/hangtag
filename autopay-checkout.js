// Hangtag's AutoPay page (autopay.html): opens Cashfree's own page for the mandate the subscription function made. The
// session id and the environment come in the address's #part, which no server sees; the page reads nothing else and sends
// nothing anywhere itself. After the owner approves, Cashfree sends the browser to the mandate's return address (the
// webhook function), which sends it on to the app.
(function () {
  var msg = document.getElementById("msg");
  function say(t) { if (msg) msg.textContent = t; }
  var p = new URLSearchParams(location.hash.slice(1)), session = p.get("cf") || "", mode = p.get("env") || "";
  if (!/^[A-Za-z0-9_.-]{10,500}$/.test(session) || (mode !== "sandbox" && mode !== "production")) {
    say("This AutoPay link isn't complete. Go back to Hangtag and choose Set up AutoPay again.");
    return;
  }
  // only a session the app on this device was given in the last 30 minutes (Plans & Billing stores it just before opening
  // this page): a link made elsewhere, with someone else's Cashfree session, doesn't open from Hangtag's page. Where the
  // browser keeps no storage at all, it can't be checked.
  var given = null, storage = true;
  try { given = JSON.parse(localStorage.getItem("hangtag.autopay.session") || "null"); } catch (e) { storage = false; }
  if (storage && !(given && given.cf === session && Date.now() - (+given.at || 0) < 30 * 60e3)) {
    say("This AutoPay link didn't come from your Hangtag app. Open Hangtag, go to Plans & Billing and choose Set up AutoPay.");
    return;
  }
  if (typeof window.Cashfree !== "function") {
    say("Cashfree's page couldn't load. Check the connection, then go back to Hangtag and choose Set up AutoPay again.");
    return;
  }
  try { localStorage.removeItem("hangtag.autopay.session"); } catch (e) { /* nothing kept */ }
  try {
    var r = window.Cashfree({ mode: mode }).subscriptionsCheckout({ subsSessionId: session, redirectTarget: "_self" });
    if (r && typeof r.then === "function") {
      r.then(function (x) { if (x && x.error) say("Cashfree's page couldn't open. Go back to Hangtag and choose Set up AutoPay again."); },
        function () { say("Cashfree's page couldn't open. Go back to Hangtag and choose Set up AutoPay again."); });
    }
  } catch (e) {
    say("Cashfree's page couldn't open. Go back to Hangtag and choose Set up AutoPay again.");
  }
})();

// MCP App (extension 2026-01-26): the approval card a compatible chat host draws under `enter_drop`.
// It shows the person what their agent just asked for and hands them to PayPal. The card has no way to approve anything:
// approval happens on PayPal's own page, in the person's own browser. Hosts without MCP Apps use `approve_url` from the
// tool result, so this is purely additive.
// One self-contained HTML string: no network access, no dependencies, and everything it shows goes through textContent.

export const APPROVAL_CARD_URI = "ui://paylet/approval-card";
export const APPROVAL_CARD_MIME = "text/html;profile=mcp-app";

export const APPROVAL_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Paylet approval</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --ink: #111110; --muted: #66645e; --line: #e5e3dc; --soft: #f5f4ef; --accent: #f5a400; --ok: #0f7a4d; --paypal: #ffc439; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1a18; --ink: #f6f5f1; --muted: #a7a49b; --line: #33312c; --soft: #252420; --ok: #4cc38a; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; }
  body { font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
  .card { background: var(--bg); border: 1px solid var(--line); border-radius: 16px; padding: 18px; max-width: 460px; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: -0.01em; }
  .brand svg { flex: none; }
  .brand span { margin-left: auto; font-size: 12px; font-weight: 500; color: var(--muted); }
  h1 { font-size: 20px; line-height: 1.2; letter-spacing: -0.015em; margin: 14px 0 2px; }
  .sub { color: var(--muted); margin: 0; }
  .amount { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; background: var(--soft); border-radius: 12px; padding: 12px 14px; margin: 14px 0; }
  .amount b { font-size: 22px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .amount small { color: var(--muted); text-align: right; }
  .stop { display: flex; gap: 8px; align-items: flex-start; font-size: 13.5px; color: var(--muted); margin: 0 0 14px; }
  .stop i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin-top: 6px; flex: none; }
  button, a.btn { display: block; width: 100%; min-height: 44px; border: 0; border-radius: 12px; background: var(--paypal); color: #111; font: 650 15px/44px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; text-decoration: none; cursor: pointer; }
  button:focus-visible, a.btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  button[disabled] { opacity: .55; cursor: default; }
  .status { margin: 12px 0 0; font-size: 13.5px; color: var(--muted); }
  .status.ok { color: var(--ok); font-weight: 600; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<main class="card" id="card" hidden>
  <div class="brand">
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M11.5 5.5H6.5v21h5M20.5 5.5h5v21h-5" fill="none" stroke="currentColor" stroke-width="3.4"/><circle cx="16" cy="16" r="4.2" fill="#f5a400"/></svg>
    paylet <span>PayPal sandbox</span>
  </div>
  <h1 id="title"></h1>
  <p class="sub" id="ref"></p>
  <div class="amount"><b id="hold"></b><small>held, not charged.<br />You pay only if you win.</small></div>
  <p class="stop"><i></i><span>Your agent stopped here. It can ask for an entry, but only you can approve the hold.</span></p>
  <button id="approve" type="button"></button>
  <a class="btn hidden" id="fallback" target="_blank" rel="noopener noreferrer"></a>
  <p class="status" id="status" role="status"></p>
</main>
<script>
(function () {
  var nextId = 1, pending = {};
  var $ = function (id) { return document.getElementById(id); };
  function send(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params }); }
  function report() {
    var r = $("card").getBoundingClientRect();
    notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) });
  }
  // Only a PayPal sandbox page can be opened from this card, whatever the tool result says.
  function safeLink(url) {
    try {
      var u = new URL(url);
      return u.protocol === "https:" && (u.hostname === "www.sandbox.paypal.com" || u.hostname === "sandbox.paypal.com") ? u.href : null;
    } catch (e) { return null; }
  }
  var entryRef = null, polling = false, done = false;
  var HOLD = { held: 1, waitlist: 1, won: 1, captured: 1, shipped: 1 };
  function setStatus(text, ok) {
    var s = $("status");
    s.textContent = text;
    s.className = ok ? "status ok" : "status";
    report();
  }
  function poll() {
    if (polling || done || !entryRef) return;
    polling = true;
    var tries = 0;
    (function tick() {
      if (done || tries++ > 100) { polling = false; return; }
      request("tools/call", { name: "entry_status", arguments: { entry_ref: entryRef } }).then(function (res) {
        var st = res && res.structuredContent && res.structuredContent.status;
        if (HOLD[st]) {
          done = true;
          $("approve").disabled = true;
          $("approve").textContent = "Approved in PayPal";
          setStatus("Hold placed. Nothing charged. You are in the ballot.", true);
        } else if (st === "duplicate") {
          done = true;
          $("approve").disabled = true;
          setStatus("This PayPal account already holds an entry, so no second hold was placed.");
        } else if (st === "expired") {
          done = true;
          $("approve").disabled = true;
          setStatus("This request expired. No hold was placed.");
        } else setTimeout(tick, 4000);
      }).catch(function () { polling = false; });
    })();
  }
  function render(data) {
    var link = safeLink(data.approve_url);
    var usd = typeof data.hold_usd === "number" ? "$" + data.hold_usd.toFixed(2) : "";
    entryRef = data.entry_ref || null;
    $("title").textContent = data.title || "Limited drop";
    $("ref").textContent = data.public_id ? "Entry " + data.public_id + ", requested by your agent" : "Requested by your agent";
    $("hold").textContent = usd;
    $("approve").textContent = "Approve " + usd + " hold in PayPal";
    $("fallback").textContent = "Approve " + usd + " hold in PayPal";
    if (!link) {
      $("approve").disabled = true;
      setStatus("This request has no valid PayPal link.");
    } else {
      $("fallback").href = link;
      $("approve").onclick = function () {
        request("ui/open-link", { url: link }).then(function () {
          setStatus("Waiting for you in PayPal…");
          poll();
        }).catch(function () {
          $("approve").classList.add("hidden");
          $("fallback").classList.remove("hidden");
          setStatus("This app can't open links by itself. Use the button above.");
          poll();
        });
      };
    }
    $("card").hidden = false;
    report();
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      return m.error ? p.reject(m.error) : p.resolve(m.result);
    }
    if (m.method === "ui/notifications/tool-result") {
      var r = m.params || {};
      if (r.structuredContent && !r.isError) render(r.structuredContent);
    }
  });
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "Paylet approval card", version: "1.0.0" }, clientInfo: { name: "Paylet approval card", version: "1.0.0" }, appCapabilities: {} })
    .then(function () { notify("ui/notifications/initialized", {}); });
})();
</script>
</body>
</html>
`;

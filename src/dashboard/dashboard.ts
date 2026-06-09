// Self-contained usage dashboard. No external assets — it polls /metrics and
// renders client-side. The client script intentionally avoids template
// literals so this server-side template literal stays simple.

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Aether Gateway — Dashboard</title>
<style>
  :root {
    --bg: #0b0f17; --panel: #131a26; --panel2: #0f1622; --line: #1e2937;
    --text: #e6edf3; --muted: #8b97a8; --accent: #5eead4; --accent2: #818cf8;
    --good: #34d399; --warn: #fbbf24; --bad: #f87171;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: radial-gradient(1200px 600px at 70% -10%, #16203099, transparent), var(--bg);
         color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 60px; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
  .logo { width: 38px; height: 38px; border-radius: 11px;
          background: linear-gradient(135deg, var(--accent), var(--accent2)); }
  h1 { font-size: 20px; margin: 0; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 13px; }
  .live { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--good); box-shadow: 0 0 0 0 #34d39988;
         animation: pulse 1.8s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 #34d39988} 70%{box-shadow:0 0 0 8px #34d39900} 100%{box-shadow:0 0 0 0 #34d39900} }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 18px; }
  .card { background: linear-gradient(180deg, var(--panel), var(--panel2)); border: 1px solid var(--line);
          border-radius: 14px; padding: 16px; }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
  .card .value { font-size: 26px; font-weight: 650; margin-top: 6px; }
  .card .value small { font-size: 13px; color: var(--muted); font-weight: 400; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
  .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); font-size: 13px; white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.hit { background: #34d39922; color: var(--good); }
  .badge.miss { background: #818cf822; color: var(--accent2); }
  .badge.open { background: #f8717122; color: var(--bad); }
  .badge.closed { background: #34d39922; color: var(--good); }
  .empty { color: var(--muted); padding: 10px 6px; }
  .foot { color: var(--muted); font-size: 12px; margin-top: 22px; }
  code { background: #0d1320; border: 1px solid var(--line); padding: 1px 6px; border-radius: 6px; color: var(--accent); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo"></div>
      <div>
        <h1>Aether Gateway</h1>
        <div class="sub">One API for OpenAI · Anthropic · Gemini — caching, failover, guardrails, cost control</div>
      </div>
      <div class="live"><span class="dot"></span><span id="updated">connecting…</span></div>
    </header>

    <div class="grid">
      <div class="card"><div class="label">Requests</div><div class="value" id="k_req">—</div></div>
      <div class="card"><div class="label">Total spend</div><div class="value" id="k_cost">—</div></div>
      <div class="card"><div class="label">Cache hit rate</div><div class="value" id="k_cache">—</div></div>
      <div class="card"><div class="label">Avg latency</div><div class="value" id="k_lat">—</div></div>
    </div>

    <div class="row2">
      <div class="panel">
        <h2>By model</h2>
        <table><thead><tr><th>Model</th><th class="num">Reqs</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
          <tbody id="t_model"></tbody></table>
      </div>
      <div class="panel">
        <h2>By provider</h2>
        <table><thead><tr><th>Provider</th><th class="num">Reqs</th><th class="num">Cost</th></tr></thead>
          <tbody id="t_provider"></tbody></table>
      </div>
    </div>

    <div class="row2">
      <div class="panel">
        <h2>Semantic cache</h2>
        <table><tbody id="t_cache"></tbody></table>
      </div>
      <div class="panel">
        <h2>Provider health (circuit breakers)</h2>
        <table><tbody id="t_health"></tbody></table>
      </div>
    </div>

    <div class="panel">
      <h2>Recent requests</h2>
      <table><thead><tr><th>Time</th><th>Model</th><th>Provider</th><th></th><th class="num">Latency</th><th class="num">Cost</th></tr></thead>
        <tbody id="t_recent"></tbody></table>
    </div>

    <div class="foot">Auto-refreshes every 4s · API: <code>POST /v1/chat/completions</code> · <code>GET /metrics</code></div>
  </div>

<script>
  function usd(n) { return "$" + (Number(n) || 0).toFixed(Number(n) >= 1 ? 2 : 4); }
  function pct(n) { return ((Number(n) || 0) * 100).toFixed(1) + "%"; }
  function ms(n) { return Math.round(Number(n) || 0) + " ms"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }
  function time(t) { try { return new Date(Number(t)).toLocaleTimeString(); } catch (e) { return ""; } }

  function rows(tbody, html) { document.getElementById(tbody).innerHTML = html; }

  async function load() {
    var d;
    try { d = await (await fetch("/metrics")).json(); }
    catch (e) { document.getElementById("updated").textContent = "offline"; return; }

    document.getElementById("k_req").textContent = d.totals.requests;
    document.getElementById("k_cost").innerHTML = usd(d.totals.costUsd);
    document.getElementById("k_cache").innerHTML = pct(d.totals.cacheHitRate) + ' <small>(' + d.totals.cacheHits + ' hits)</small>';
    document.getElementById("k_lat").innerHTML = ms(d.totals.avgLatencyMs);

    var mh = "";
    (d.byModel || []).forEach(function(r){
      mh += "<tr><td>" + esc(r.model) + "</td><td class='num'>" + r.requests + "</td><td class='num'>" + r.tokens + "</td><td class='num'>" + usd(r.costUsd) + "</td></tr>";
    });
    rows("t_model", mh || "<tr><td class='empty' colspan='4'>No requests yet</td></tr>");

    var ph = "";
    (d.byProvider || []).forEach(function(r){
      ph += "<tr><td>" + esc(r.provider) + "</td><td class='num'>" + r.requests + "</td><td class='num'>" + usd(r.costUsd) + "</td></tr>";
    });
    rows("t_provider", ph || "<tr><td class='empty' colspan='3'>No requests yet</td></tr>");

    var c = d.cache || {};
    rows("t_cache",
      "<tr><th>Embedder</th><td class='num'>" + esc(c.embedder) + "</td></tr>" +
      "<tr><th>Entries</th><td class='num'>" + (c.entries||0) + "</td></tr>" +
      "<tr><th>Hits / Misses</th><td class='num'>" + (c.hits||0) + " / " + (c.misses||0) + "</td></tr>" +
      "<tr><th>Enabled</th><td class='num'>" + (c.enabled ? "yes" : "no") + "</td></tr>");

    var hk = Object.keys(d.circuits || {});
    var hh = "";
    hk.forEach(function(k){
      var v = d.circuits[k];
      var b = v.open ? "<span class='badge open'>open</span>" : "<span class='badge closed'>healthy</span>";
      hh += "<tr><th>" + esc(k) + "</th><td class='num'>" + b + " <span style='color:var(--muted)'>" + v.failures + " fails</span></td></tr>";
    });
    rows("t_health", hh || "<tr><td class='empty'>All targets healthy</td></tr>");

    var rh = "";
    (d.recent || []).forEach(function(e){
      var badge = e.cached ? "<span class='badge hit'>cache</span>" : "<span class='badge miss'>live</span>";
      rh += "<tr><td>" + time(e.ts) + "</td><td>" + esc(e.requested_model) + "</td><td>" + esc(e.provider || e.upstream_model || "—") + "</td><td>" + badge + "</td><td class='num'>" + ms(e.latency_ms) + "</td><td class='num'>" + usd(e.cost_usd) + "</td></tr>";
    });
    rows("t_recent", rh || "<tr><td class='empty' colspan='6'>No requests yet — try the curl in the README</td></tr>");

    document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
  }
  load();
  setInterval(load, 4000);
</script>
</body>
</html>`;
}


function esc(v) {
  if (v == null) return '';
  const d = document.createElement('div'); d.textContent = String(v); return d.innerHTML;
}
function fmt$(v) { return '$' + Number(v||0).toFixed(2); }
function fmtPct(v) { const n = Number(v||0); return (n>=0?'+':'') + n.toFixed(2) + '%'; }
function pnlC(v) { return v >= 0 ? 'pos' : 'neg'; }

function hdrs() {
  const h = {};
  const key = localStorage.getItem('doomtrade_api_key');
  if (key) h['Authorization'] = 'Bearer ' + key;
  return h;
}
// Prompt for the API key (stored client-side only — the server no longer
// injects it into the page). Cancel clears the stored key.
function setApiKey() {
  const cur = localStorage.getItem('doomtrade_api_key') || '';
  const v = prompt('DoomTrade API key (leave blank + OK to clear):', cur);
  if (v === null) return;
  if (v.trim()) localStorage.setItem('doomtrade_api_key', v.trim());
  else localStorage.removeItem('doomtrade_api_key');
  toast(v.trim() ? 'API key saved' : 'API key cleared', true);
  refresh();
}
async function api(path) {
  const r = await fetch(path, { headers: hdrs() });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function apiPost(path) {
  const r = await fetch(path, { method: 'POST', headers: hdrs() });
  return r.json();
}

function toast(msg, ok) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Fetch & render ───────────────────────────────
// Fast refresh: agents only (10s)
async function refresh() {
  const dot = document.getElementById('dot');
  try {
    const [health, agentsR, leaderR] = await Promise.all([
      api('/api/health'),
      api('/api/agents'),
      api('/api/agents/leaderboard'),
    ]);

    const agents = agentsR.agents || [];
    const ranks = {};
    (leaderR.leaderboard || []).forEach(e => ranks[e.name] = e.rank);

    // Fetch per-agent details in parallel
    const details = await Promise.all(agents.map(async a => {
      try {
        const [port, pos, trd, ana] = await Promise.all([
          api(`/api/agents/${a.id}/portfolio`),
          api(`/api/agents/${a.id}/positions`),
          api(`/api/agents/${a.id}/trades?limit=5`),
          api(`/api/agents/${a.id}/analytics`),
        ]);
        return { a, port: port.portfolio||{}, pos: pos.positions||[], trd: trd.trades||[], ana: ana.analytics||{}, rank: ranks[a.name]||'-' };
      } catch(e) {
        return { a, port: {}, pos: [], trd: [], ana: {}, rank: ranks[a.name]||'-' };
      }
    }));

    render(details);
    dot.classList.remove('error');
    document.getElementById('ts').textContent = new Date().toLocaleTimeString();
    document.getElementById('mode').textContent = (health.mode||'sim').toUpperCase();
    document.getElementById('info').textContent = `${agents.length} agents · uptime ${Math.round(health.uptime||0)}s`;
  } catch(e) {
    dot.classList.add('error');
    document.getElementById('ts').textContent = 'Error: ' + e.message;
    // 401 = no/invalid API key stored — guide the user instead of hanging on "Loading…"
    if (String(e.message).startsWith('401')) {
      const hasKey = !!localStorage.getItem('doomtrade_api_key');
      const grid = document.getElementById('grid');
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:48px 16px">
          <div style="font-size:15px;font-weight:700;margin-bottom:8px">API key required</div>
          <div style="color:var(--muted);font-size:12px;margin-bottom:16px;max-width:420px;margin-inline:auto">
            ${hasKey
              ? 'The stored API key was rejected (HTTP 401). It may have changed — set it again.'
              : 'This dashboard now requires the DoomTrade API key (it is no longer embedded in the page). Click below to provide it once; it is stored in this browser only.'}
          </div>
          <button class="btn" id="btn-set-key" style="margin:0 auto">🔑 ${hasKey ? 'Update API Key' : 'Set API Key'}</button>
        </div>`;
      const bar = document.getElementById('market-bar');
      bar.innerHTML = '<div style="color:var(--dim);padding:10px 14px;font-size:11px">Market data requires the API key</div>';
    }
  }
}

// Slow refresh: market data (60s, non-blocking)
const MARKET_SYMBOLS = ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','ADA/USDT','DOGE/USDT','AVAX/USDT'];

async function refreshMarket() {
  try {
    const snapR = await api('/api/market/snapshot?symbols=' + MARKET_SYMBOLS.join(','));

    // Fetch research analyses in parallel (each takes ~3s from Kraken)
    const analyses = await Promise.all(
      MARKET_SYMBOLS.map(async s => {
        try {
          const r = await api(`/api/research/analyze?symbol=${encodeURIComponent(s)}&timeframe=1Day&range=1m`);
          return { symbol: s, analysis: r.analysis || r };
        } catch { return { symbol: s, analysis: null }; }
      })
    );

    renderMarket(snapR.snapshots || [], analyses);
  } catch(e) {
    console.error('Market refresh error:', e);
  }
}

function renderMarket(snapshots, analyses) {
  const bar = document.getElementById('market-bar');
  const analysisMap = {};
  analyses.forEach(a => { if (a.analysis) analysisMap[a.symbol] = a.analysis; });

  if (!snapshots.length) {
    bar.innerHTML = '<div style="color:var(--dim);padding:10px 14px;font-size:11px">Market data unavailable</div>';
    return;
  }

  bar.innerHTML = snapshots.map(s => {
    const sym = s.symbol || '';
    const price = Number(s.price || 0);
    const chg = Number(s.changePct || 0);
    const chgClass = chg >= 0 ? 'pos' : 'neg';
    const chgSign = chg >= 0 ? '+' : '';

    // Format price nicely
    let priceStr;
    if (price >= 1000) priceStr = '$' + price.toFixed(0);
    else if (price >= 1) priceStr = '$' + price.toFixed(2);
    else priceStr = '$' + price.toFixed(4);

    // Get analysis data
    const ana = analysisMap[sym];
    let rsi = '', signal = '';
    if (ana) {
      const rsiVal = ana.indicators?.rsi14;
      if (rsiVal != null) rsi = `RSI ${rsiVal.toFixed(0)}`;
      const sig = ana.signals?.combined || 'neutral';
      const sigClass = sig === 'buy' ? 'sig-buy' : sig === 'sell' ? 'sig-sell' : 'sig-neutral';
      signal = `<span class="signal-tag ${sigClass}">${sig}</span>`;
    }

    return `<div class="ticker-item">
      <div class="ticker-sym">${esc(sym.replace('/USDT',''))}${signal}</div>
      <div class="ticker-price">${priceStr}</div>
      <div class="ticker-chg ${chgClass}">${chgSign}${chg.toFixed(2)}%</div>
      <div class="ticker-rsi">${rsi}</div>
    </div>`;
  }).join('');
}

function render(agents) {
  const grid = document.getElementById('grid');
  if (!agents.length) {
    grid.innerHTML = '<div style="color:var(--muted);padding:48px;text-align:center;grid-column:1/-1">No agents registered</div>';
    return;
  }
  grid.innerHTML = agents.map(renderCard).join('');
}

function renderCard(d) {
  const a = d.a;
  const equity = d.port.equity ?? a.equity ?? a.cash ?? 0;
  const cash = d.port.cash ?? a.cash ?? 0;
  const init = a.initialBalance || a.starting_balance || 100;
  const pnl = equity - init;
  const retPct = (pnl / init) * 100;
  const rank = d.rank;
  const rk = rank <= 3 ? `r${rank}` : '';

  let h = `<div class="card">`;

  // Header: rank, name, strategy, active status
  h += `<div class="card-head">
    <div class="card-head-left">
      <div class="rank ${rk}">${esc(rank)}</div>
      <div>
        <span class="agent-name">${esc(a.name)}</span>
        <span class="strategy-pill">${esc(a.strategy || 'none')}</span>
      </div>
    </div>
    <div class="card-head-left">
      <span class="active-dot ${a.active ? 'on' : 'off'}"></span>
      <span style="font-size:10px;color:var(--muted)">${a.active ? 'active' : 'inactive'}</span>
    </div>
  </div>`;

  // Equity row: equity, P&L, return
  h += `<div class="equity-row">
    <div class="equity-item">
      <div class="equity-label">Equity</div>
      <div class="equity-value">${fmt$(equity)}</div>
    </div>
    <div class="equity-item">
      <div class="equity-label">P&L</div>
      <div class="equity-value ${pnlC(pnl)}">${pnl>=0?'+':''}${fmt$(pnl)}</div>
      <div class="equity-sub ${pnlC(retPct)}">${fmtPct(retPct)}</div>
    </div>
    <div class="equity-item">
      <div class="equity-label">Cash</div>
      <div class="equity-value">${fmt$(cash)}</div>
    </div>
  </div>`;

  // Metrics bar: positions, trades, win rate, drawdown
  h += `<div class="metrics-bar">
    <span class="metric-item"><strong>${d.pos.length}</strong> positions</span>
    <span class="metric-item"><strong>${d.trd.length}</strong> recent trades</span>
    <span class="metric-item">win rate <strong>${Number(d.ana.winRate||0).toFixed(0)}%</strong></span>
    <span class="metric-item">max DD <strong>${Number(d.ana.maxDrawdownPct||0).toFixed(1)}%</strong></span>
  </div>`;

  // Positions
  h += `<div class="section-head">Positions</div>`;
  if (d.pos.length) {
    h += `<table><tr><th>Symbol</th><th style="text-align:right">Qty</th><th style="text-align:right">Entry</th><th style="text-align:right">Current</th><th style="text-align:right">P&L</th></tr>`;
    d.pos.forEach(p => {
      const u = p.unrealizedPnl || 0;
      const cur = p.currentPrice || p.avgEntryPrice || 0;
      h += `<tr>
        <td class="sym">${esc(p.symbol)}</td>
        <td style="text-align:right">${Number(p.quantity||0).toFixed(6)}</td>
        <td style="text-align:right">${fmt$(p.avgEntryPrice)}</td>
        <td style="text-align:right">${fmt$(cur)}</td>
        <td style="text-align:right" class="${pnlC(u)}">${u>=0?'+':''}${fmt$(u)}</td>
      </tr>`;
    });
    h += `</table>`;
  } else {
    h += `<div class="empty">No open positions</div>`;
  }

  // Recent trades
  h += `<div class="section-head">Recent Trades</div>`;
  if (d.trd.length) {
    h += `<table><tr><th>Time</th><th>Symbol</th><th>Side</th><th style="text-align:right">Qty</th><th style="text-align:right">Fill</th><th style="text-align:right">Fee</th></tr>`;
    d.trd.forEach(t => {
      const tm = new Date(t.created_at || t.filled_at || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      const sc = t.side === 'buy' ? 'side-buy' : 'side-sell';
      h += `<tr>
        <td style="color:var(--muted)">${esc(tm)}</td>
        <td class="sym">${esc(t.symbol)}</td>
        <td class="${sc}">${esc(t.side).toUpperCase()}</td>
        <td style="text-align:right">${Number(t.quantity||0).toFixed(6)}</td>
        <td style="text-align:right">${fmt$(t.fill_price)}</td>
        <td style="text-align:right;color:var(--muted)">${fmt$(t.fee)}</td>
      </tr>`;
    });
    h += `</table>`;
  } else {
    h += `<div class="empty">No trades yet</div>`;
  }

  h += `</div>`;
  return h;
}

// ── Actions ──────────────────────────────────────
async function evalAll() {
  const btn = document.getElementById('btn-eval');
  btn.disabled = true; btn.textContent = 'Evaluating…';
  try {
    const agents = (await api('/api/agents')).agents || [];
    for (const a of agents) {
      if (!a.active) continue;
      const r = await apiPost(`/api/agents/${a.id}/evaluate`);
      toast(`${a.name}: ${r.signals||0} signals, ${r.trades||0} trades`, !r.errors?.length);
    }
    await refresh();
  } catch(e) { toast(e.message, false); }
  btn.disabled = false; btn.textContent = '▶ Evaluate All';
}

async function runA2A() {
  const btn = document.getElementById('btn-a2a');
  btn.disabled = true; btn.textContent = '⚡ Running…';
  try {
    const r = await apiPost('/api/agents/a2a-cycle');
    const errs = r.errors?.length || 0;
    toast(`A2A: ${r.signals?.length||0} signals, ${r.validations?.length||0} validations, ${errs} errors`, errs === 0);
    await refresh();
  } catch(e) { toast(e.message, false); }
  btn.disabled = false; btn.textContent = '⚡ Run A2A Cycle';
}

// ── Init ─────────────────────────────────
// CSP: helmet sets script-src-attr 'none', so NO inline onclick attributes.
// Wire every button here instead (ids in the markup).
function wireButtons() {
  const a2a = document.getElementById('btn-a2a');
  if (a2a) a2a.addEventListener('click', () => runA2A());
  const ev = document.getElementById('btn-eval');
  if (ev) ev.addEventListener('click', () => evalAll());
  const key = document.getElementById('btn-key');
  if (key) key.addEventListener('click', () => setApiKey());
  // Delegated: the 401 panel's Set Key button is injected at runtime
  document.addEventListener('click', e => {
    const t = e.target && e.target.closest ? e.target.closest('#btn-set-key') : null;
    if (t) setApiKey();
  });
}
wireButtons();
refresh();
refreshMarket();
setInterval(refresh, 10000);       // agents every 10s
setInterval(refreshMarket, 60000); // market every 60s (Kraken is slow)

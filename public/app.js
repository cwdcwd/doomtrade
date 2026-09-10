// DoomTrade dashboard — read-only public viewer.
// Single GET /api/dashboard every 10s (server caches upstream fetches).
// No API key, no localStorage, no mutations: fleet crons do the trading.

function esc(v) {
  if (v == null) return '';
  const d = document.createElement('div'); d.textContent = String(v); return d.innerHTML;
}
function fmt$(v) { return '$' + Number(v||0).toFixed(2); }
function fmtPct(v) { const n = Number(v||0); return (n>=0?'+':'') + n.toFixed(2) + '%'; }
function pnlC(v) { return v >= 0 ? 'pos' : 'neg'; }

function toast(msg, ok) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Fetch & render ───────────────────────────────
async function refresh() {
  const dot = document.getElementById('dot');
  try {
    const r = await fetch('/api/dashboard');
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const payload = await r.json();

    render(payload.agents || [], payload.leaderboard || []);
    renderMarket((payload.market && payload.market.snapshots) || [],
                 (payload.market && payload.market.research) || []);
    dot.classList.remove('error');
    document.getElementById('ts').textContent = new Date().toLocaleTimeString();
    document.getElementById('mode').textContent = (payload.mode||'sim').toUpperCase();
    const n = (payload.agents || []).length;
    document.getElementById('info').textContent = `${n} agents · uptime ${Math.round(payload.uptime||0)}s`;
  } catch(e) {
    dot.classList.add('error');
    document.getElementById('ts').textContent = 'Error: ' + e.message;
  }
}

function renderMarket(snapshots, research) {
  const bar = document.getElementById('market-bar');
  const analysisMap = {};
  research.forEach(r => { if (r && r.analysis) analysisMap[r.symbol] = r.analysis; });

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

    let priceStr;
    if (price >= 1000) priceStr = '$' + price.toFixed(0);
    else if (price >= 1) priceStr = '$' + price.toFixed(2);
    else priceStr = '$' + price.toFixed(4);

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

function render(agents, leaderboard) {
  const grid = document.getElementById('grid');
  if (!agents.length) {
    grid.innerHTML = '<div style="color:var(--muted);padding:48px;text-align:center;grid-column:1/-1">No agents registered</div>';
    return;
  }
  const ranks = {};
  leaderboard.forEach(e => ranks[e.name] = e.rank);
  grid.innerHTML = agents.map(d =>
    renderCard({ ...d, rank: ranks[d.agent?.name] ?? '-' })
  ).join('');
}

function renderCard(d) {
  const a = d.agent || {};
  const equity = d.portfolio?.equity ?? a.equity ?? a.cash ?? 0;
  const cash = d.portfolio?.cash ?? a.cash ?? 0;
  const init = a.initialBalance || a.starting_balance || 100;
  const pnl = equity - init;
  const retPct = (pnl / init) * 100;
  const rank = d.rank;
  const rk = rank <= 3 ? `r${rank}` : '';
  const positions = d.positions || [];
  const trades = d.trades || [];

  let h = `<div class="card">`;

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

  const ana = d.analytics || {};
  h += `<div class="metrics-bar">
    <span class="metric-item"><strong>${positions.length}</strong> positions</span>
    <span class="metric-item"><strong>${trades.length}</strong> recent trades</span>
    <span class="metric-item">win rate <strong>${Number(ana.winRate||0).toFixed(0)}%</strong></span>
    <span class="metric-item">max DD <strong>${Number(ana.maxDrawdownPct||0).toFixed(1)}%</strong></span>
  </div>`;

  h += `<div class="section-head">Positions</div>`;
  if (positions.length) {
    h += `<table><tr><th>Symbol</th><th style="text-align:right">Qty</th><th style="text-align:right">Entry</th><th style="text-align:right">Current</th><th style="text-align:right">P&L</th></tr>`;
    positions.forEach(p => {
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

  h += `<div class="section-head">Recent Trades</div>`;
  if (trades.length) {
    h += `<table><tr><th>Time</th><th>Symbol</th><th>Side</th><th style="text-align:right">Qty</th><th style="text-align:right">Fill</th><th style="text-align:right">Fee</th></tr>`;
    trades.forEach(t => {
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

// ── Init ─────────────────────────────────────────
refresh();
setInterval(refresh, 10000); // one request per cycle — server caches upstreams
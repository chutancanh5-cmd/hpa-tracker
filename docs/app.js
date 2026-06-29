/* HPA · Sổ đầu tư — logic toàn bộ (vanilla JS, lưu localStorage) */
'use strict';

const KEY_TX = 'hpa_tx_v1';
const KEY_SET = 'hpa_settings_v1';
const KEY_DATA = 'hpa_data_cache_v1';

const DEFAULT_SETTINGS = { feeBuy: 0.15, feeSell: 0.15, taxSell: 0.10, taxDiv: 5.0, adjustCostByDiv: true };

let DATA = null;        // dữ liệu thị trường (từ data/hpa.json)
let TX = [];            // giao dịch của người dùng
let SETTINGS = { ...DEFAULT_SETTINGS };
let editingId = null;   // id lệnh đang sửa
let txType = 'buy';
let adjMode = 'raw';

/* ---------- Seed: vị thế ban đầu của bạn (sẽ điền sau khi xác nhận) ---------- */
const SEED_TX = [
  // { date:'2026-02-10', type:'buy', qty:1000, price:40000, fee:null }
];

/* ===================== Helpers ===================== */
const $ = (id) => document.getElementById(id);
// "Hôm nay" theo giờ Việt Nam (UTC+7), không phụ thuộc múi giờ thiết bị
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

function vnd(n, dp = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('vi-VN', { maximumFractionDigits: dp }) + ' đ';
}
function money(n) { // gọn cho số lớn
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + ' tỷ';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.?0+$/, '') + ' tr';
  return vnd(n);
}
function pct(n, dp = 2) { return (n == null || isNaN(n)) ? '—' : n.toFixed(dp) + '%'; }
function signed(fn, n) { return (n > 0 ? '+' : '') + fn(n); }
function cls(n) { return n > 0 ? 'pos' : (n < 0 ? 'neg' : ''); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* ===================== Load / Save ===================== */
function loadState() {
  try { TX = JSON.parse(localStorage.getItem(KEY_TX)) || []; } catch { TX = []; }
  try { SETTINGS = { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(KEY_SET)) || {}) }; } catch {}
  if (!TX.length && SEED_TX.length) { TX = SEED_TX.map(t => ({ id: uid(), ...t })); saveTx(); }
}
function saveTx() { localStorage.setItem(KEY_TX, JSON.stringify(TX)); }
function saveSettings() { localStorage.setItem(KEY_SET, JSON.stringify(SETTINGS)); }

async function loadData() {
  try {
    const r = await fetch('data/hpa.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    DATA = await r.json();
    localStorage.setItem(KEY_DATA, JSON.stringify(DATA));
  } catch (e) {
    const cached = localStorage.getItem(KEY_DATA);
    if (cached) DATA = JSON.parse(cached);
    else DATA = { symbol: 'HPA', current_price: null, dividends: [], peers: [], fundamentals: {}, price_history: [], adj_history: [], cycle: {} };
  }
}

/* ===================== Portfolio math (bình quân giá vốn) ===================== */
function feeFor(type, qty, price) {
  const v = qty * price;
  return type === 'buy'
    ? Math.round(v * SETTINGS.feeBuy / 100)
    : Math.round(v * (SETTINGS.feeSell + SETTINGS.taxSell) / 100);
}
function txFee(t) { return (t.fee != null) ? t.fee : feeFor(t.type, t.qty, t.price); }

function sortedTx() {
  return [...TX].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function computePortfolio(adjustOverride) {
  const adjust = (adjustOverride != null) ? adjustOverride : (SETTINGS.adjustCostByDiv !== false);
  const tDay = today();
  // Gộp giao dịch + cổ tức, xử lý theo trình tự thời gian.
  // Cổ tức (ord 0) xử lý TRƯỚC giao dịch (ord 1) cùng ngày: mua đúng ngày GDKHQ không được cổ tức.
  const events = [];
  for (const t of TX) events.push({ date: t.date, ord: 1, tx: t });
  for (const d of (DATA?.dividends || [])) if (d.ex_date && d.value) events.push({ date: d.ex_date, ord: 0, div: d });
  events.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord);

  let qty = 0, cost = 0, rawCost = 0, realized = 0, buyCostSum = 0, sellProceeds = 0;
  const div = { detail: [], grossReceived: 0, netReceived: 0, grossUpcoming: 0, netUpcoming: 0 };

  for (const ev of events) {
    if (ev.tx) {
      const t = ev.tx, fee = txFee(t), val = t.qty * t.price + fee;
      if (t.type === 'buy') {
        cost += val; rawCost += val; qty += t.qty; buyCostSum += val;
      } else {
        const avg = qty > 0 ? cost / qty : 0, ravg = qty > 0 ? rawCost / qty : 0;
        const proceeds = t.qty * t.price - fee;
        realized += proceeds - t.qty * avg;
        cost -= t.qty * avg; rawCost -= t.qty * ravg; qty -= t.qty; sellProceeds += proceeds;
        if (qty < 1e-6) { qty = 0; cost = 0; rawCost = 0; }
      }
    } else {
      const d = ev.div, shares = qty;           // số CP nắm giữ TRƯỚC ngày GDKHQ
      if (shares > 0) {
        const gross = shares * d.value, net = Math.round(gross * (1 - SETTINGS.taxDiv / 100));
        const entitled = d.ex_date <= tDay;     // đã chốt quyền
        const paid = d.pay_date ? d.pay_date <= tDay : entitled;
        div.detail.push({ ...d, shares, gross, net, paid });
        if (entitled) {
          div.grossReceived += gross; div.netReceived += net;
          if (adjust) cost -= net;              // trừ cổ tức vào giá vốn (giống công ty CK)
        } else { div.grossUpcoming += gross; div.netUpcoming += net; }
      }
    }
  }
  const price = DATA?.current_price || 0;
  const avgCost = qty > 0 ? cost / qty : 0;
  const rawAvgCost = qty > 0 ? rawCost / qty : 0;
  const marketValue = qty * price;
  const unreal = marketValue - cost;
  // Tổng lời/lỗ GIỐNG NHAU ở cả 2 chế độ; chỉ khác cách phân bổ cổ tức vào giá vốn hay tách riêng.
  const totalReturn = adjust ? (realized + unreal) : (realized + unreal + div.netReceived);
  const roi = buyCostSum > 0 ? totalReturn / buyCostSum * 100 : 0;
  return { qty, avgCost, rawAvgCost, cost, rawCost, marketValue, unreal,
           unrealPct: cost !== 0 ? unreal / Math.abs(cost) * 100 : 0,
           realized, buyCostSum, sellProceeds, div, totalReturn, roi, price, adjust };
}

/* ===================== Render ===================== */
function renderHeader() {
  $('tbName').textContent = DATA.short_name || 'Nông nghiệp Hòa Phát';
  $('tbPrice').textContent = DATA.current_price ? DATA.current_price.toLocaleString('vi-VN') : '—';
  const ch = DATA.change, cp = DATA.change_pct;
  const elc = $('tbChange');
  if (ch != null) {
    elc.textContent = `${ch > 0 ? '▲' : ch < 0 ? '▼' : ''} ${Math.abs(ch).toLocaleString('vi-VN')} (${signed(x => pct(x), cp)})`;
    elc.style.color = ch >= 0 ? '#bff5d7' : '#ffd2d2';
  }
  if (DATA.updated_at) {
    const dt = new Date(DATA.updated_at);
    $('updated').textContent = 'Cập nhật: ' + dt.toLocaleString('vi-VN');
  }
}

function renderOverview() {
  const p = computePortfolio();
  $('emptyHint').style.display = TX.length ? 'none' : 'block';

  $('heroValue').textContent = money(p.marketValue);
  $('heroSub').textContent = p.qty ? `${p.qty.toLocaleString('vi-VN')} CP × ${vnd(p.price)}` : 'Chưa nắm giữ CP nào';

  $('sInvested').textContent = money(p.cost);
  $('sQty').textContent = p.qty ? p.qty.toLocaleString('vi-VN') + ' CP' : '';
  $('sAvg').textContent = p.qty ? vnd(p.avgCost) : '—';
  $('sAvgSub').textContent = !p.qty ? ''
    : (p.adjust && p.div.netReceived > 0) ? `gốc ${vnd(p.rawAvgCost)} · đã trừ cổ tức`
    : `hiện ${vnd(p.price)}`;

  setStat('sUnreal', p.unreal, money); $('sUnrealPct').textContent = p.qty ? signed(x => pct(x), p.unrealPct) : '';
  setStat('sReal', p.realized, money);
  $('sDiv').textContent = money(p.div.netReceived); $('sDiv').className = 'stat-val ' + (p.div.netReceived > 0 ? 'pos' : '');
  $('sDivSub').textContent = p.div.netUpcoming > 0 ? 'sắp nhận ' + money(p.div.netUpcoming)
    : (p.adjust && p.div.netReceived > 0) ? 'đã trừ vào giá vốn' : 'sau thuế';
  setStat('sTotal', p.totalReturn, money); $('sTotalPct').textContent = p.buyCostSum ? signed(x => pct(x), p.roi) : '';

  // facts
  const f = DATA.fundamentals || {};
  const facts = [
    ['Giá hiện tại', vnd(DATA.current_price)],
    ['P/E', f.pe ?? '—'],
    ['P/B', f.pb ?? '—'],
    ['ROE', pct(f.roe, 1)],
    ['Tỷ suất cổ tức', pct(f.div_yield, 1)],
    ['Vốn hóa', money(DATA.market_cap)],
    ['Cách đỉnh 1 năm', DATA.cycle?.from_high_pct != null ? pct(DATA.cycle.from_high_pct, 1) : '—'],
  ];
  $('quickFacts').innerHTML = facts.map(([k, v]) => `<div class="fact"><span class="muted">${k}</span><b>${v}</b></div>`).join('');
  renderEquity();
}
function setStat(id, n, fn) { const e = $(id); e.textContent = signed(fn, n); e.className = 'stat-val ' + cls(n); }

function renderTrades() {
  $('txCount').textContent = TX.length ? `(${TX.length})` : '';
  const list = $('txList');
  if (!TX.length) { list.innerHTML = '<p class="muted small">Chưa có lệnh nào.</p>'; }
  else {
    list.innerHTML = sortedTx().reverse().map(t => {
      const fee = txFee(t);
      const val = t.qty * t.price + (t.type === 'buy' ? fee : -fee);
      return `<div class="tx" data-id="${t.id}">
        <span class="tx-badge ${t.type}">${t.type === 'buy' ? 'MUA' : 'BÁN'}</span>
        <div class="tx-main" data-edit="${t.id}">
          <div class="tx-l1">${t.qty.toLocaleString('vi-VN')} CP @ ${vnd(t.price)}</div>
          <div class="tx-l2">${t.date} · phí/thuế ${vnd(fee)}</div>
        </div>
        <div class="tx-amt">${money(val)}</div>
        <button class="tx-del" data-del="${t.id}">✕</button>
      </div>`;
    }).join('');
  }
  $('feeHint').textContent = `(tự tính ~${txType === 'buy' ? SETTINGS.feeBuy : (SETTINGS.feeSell + SETTINGS.taxSell)}%)`;
  $('setFeeBuy').value = SETTINGS.feeBuy; $('setFeeSell').value = SETTINGS.feeSell;
  $('setTaxSell').value = SETTINGS.taxSell; $('setTaxDiv').value = SETTINGS.taxDiv;
  $('setAdjustDiv').checked = SETTINGS.adjustCostByDiv !== false;
  renderBreakeven();
}

function renderDividends() {
  const p = computePortfolio();
  const d = p.div;
  $('divTotal').textContent = money(d.netReceived);
  $('divTotalSub').textContent = d.grossReceived
    ? `Trước thuế ${money(d.grossReceived)} · thuế ${SETTINGS.taxDiv}%${p.adjust ? ' · đã trừ vào giá vốn' : ''}`
    : 'Chưa nhận cổ tức nào';
  const dl = $('divList');
  if (!d.detail.length) dl.innerHTML = '<p class="muted small">Bạn chưa nắm giữ CP vào kỳ chốt quyền nào. Nhập lệnh mua để app tự tính.</p>';
  else dl.innerHTML = d.detail.map(x => `<div class="dv">
      <div class="dv-l"><div class="dv-y">Cổ tức ${x.year || ''} · ${vnd(x.value)}/CP</div>
        <div class="muted small">GDKHQ ${x.ex_date} · ${x.shares.toLocaleString('vi-VN')} CP ${x.paid ? '' : '<span class="tag up">sắp nhận</span>'}</div></div>
      <div class="dv-r"><b class="pos">${money(x.net)}</b><div class="muted small">gộp ${money(x.gross)}</div></div>
    </div>`).join('');

  const sch = $('divSchedule');
  sch.innerHTML = (DATA.dividends || []).map(x => `<div class="sc">
      <div class="dv-l"><b>${x.year || '—'}</b> &nbsp;<span class="muted small">GDKHQ ${x.ex_date || '—'}${x.pay_date ? ' · trả ' + x.pay_date : ''}</span></div>
      <div class="dv-r"><b>${vnd(x.value)}</b>${x.ratio ? `<div class="muted small">tỷ lệ ${(x.ratio * 100).toFixed(1)}%</div>` : ''}</div>
    </div>`).join('');
  renderNews();
}

function renderFundamentals() {
  const f = DATA.fundamentals || {};
  const items = [
    ['P/E', f.pe, 'lần'], ['P/B', f.pb, 'lần'],
    ['ROE', f.roe != null ? f.roe + '%' : null, ''], ['ROA', f.roa != null ? f.roa + '%' : null, ''],
    ['EPS', f.eps ? vnd(f.eps) : null, ''], ['Giá trị sổ sách', f.bvps ? vnd(f.bvps) : null, ''],
    ['Biên LN gộp', f.gross_margin != null ? f.gross_margin + '%' : null, ''],
    ['Biên LN ròng', f.net_margin != null ? f.net_margin + '%' : null, ''],
    ['Tỷ suất cổ tức', f.div_yield != null ? f.div_yield + '%' : null, ''],
    ['Nợ/VCSH', f.debt_equity, 'lần'], ['Thanh toán hiện hành', f.current_ratio, 'lần'],
    ['EV/EBITDA', f.ev_ebitda, 'lần'],
  ];
  $('fundGrid').innerHTML = items.map(([k, v]) =>
    `<div class="fg"><div class="fg-l">${k}</div><div class="fg-v">${v ?? '—'}</div></div>`).join('');

  // peer table
  const peers = (DATA.peers || []).filter(p => p.pe != null || p.roe != null);
  const me = { symbol: 'HPA', name: 'Nông nghiệp Hòa Phát', price: DATA.current_price,
               pe: f.pe, pb: f.pb, roe: f.roe, market_cap: DATA.market_cap, me: true };
  const rows = [me, ...peers];
  let html = `<thead><tr><th>Mã</th><th>Giá</th><th>P/E</th><th>P/B</th><th>ROE</th><th>Vốn hóa</th></tr></thead><tbody>`;
  html += rows.map(p => `<tr class="${p.me ? 'me' : ''}">
      <td>${p.symbol}</td><td>${p.price ? p.price.toLocaleString('vi-VN') : '—'}</td>
      <td>${p.pe ?? '—'}</td><td>${p.pb ?? '—'}</td>
      <td>${p.roe != null ? p.roe.toFixed(1) + '%' : '—'}</td><td>${money(p.market_cap)}</td></tr>`).join('');
  html += '</tbody>';
  $('peerTable').innerHTML = html;
  $('peerNote').textContent = `HPA (dòng xanh) có ROE ${pct(f.roe, 0)} — so sánh trực tiếp với ${peers.length} doanh nghiệp cùng ngành.`;
  $('profile').textContent = DATA.profile || '—';
}

function renderChart() {
  renderTechnical();
  renderBenchmark();
  const series = adjMode === 'adj'
    ? (DATA.adj_history || []).map(d => ({ t: d.t, c: d.c }))
    : (DATA.price_history || []).map(d => ({ t: d.t, c: d.c }));
  $('priceChart').innerHTML = lineChartSVG(series.filter(d => d.c != null));
  const lg = adjMode === 'adj'
    ? '<span class="lg-price">Giá điều chỉnh theo cổ tức</span>'
    : '<span class="lg-price">Giá đóng cửa thực tế</span>';
  $('chartLegend').innerHTML = lg;

  const c = DATA.cycle || {};
  $('cycleGrid').innerHTML = [
    ['Số phiên niêm yết', c.bars ?? '—'],
    ['Đỉnh', c.high ? vnd(c.high) : '—'],
    ['Đáy', c.low ? vnd(c.low) : '—'],
    ['Biên độ', c.range_pct != null ? pct(c.range_pct, 1) : '—'],
    ['Cách đỉnh', c.from_high_pct != null ? pct(c.from_high_pct, 1) : '—'],
    ['Drawdown lớn nhất', c.max_drawdown_pct != null ? pct(c.max_drawdown_pct, 1) : '—'],
  ].map(([k, v]) => `<div class="fg"><div class="fg-l">${k}</div><div class="fg-v">${v}</div></div>`).join('');
  $('cycleNote').textContent = c.note || '';

  // position chart
  const p = computePortfolio();
  $('posChart').innerHTML = lineChartSVG(
    (DATA.price_history || []).map(d => ({ t: d.t, c: d.c })).filter(d => d.c != null),
    { avg: p.qty ? p.avgCost : null, markers: TX }
  );
}

/* ---------- SVG line chart (không phụ thuộc thư viện) ---------- */
function lineChartSVG(data, opts = {}) {
  if (!data.length) return '<p class="muted small">Chưa có dữ liệu giá.</p>';
  const W = 520, H = 200, padL = 8, padR = 8, padT = 12, padB = 22;
  const xs = data.map((_, i) => i);
  let cs = data.map(d => d.c);
  let lo = Math.min(...cs), hi = Math.max(...cs);
  if (opts.avg) { lo = Math.min(lo, opts.avg); hi = Math.max(hi, opts.avg); }
  const padv = (hi - lo) * 0.08 || 1; lo -= padv; hi += padv;
  const X = i => padL + (i / (data.length - 1 || 1)) * (W - padL - padR);
  const Y = v => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d.c).toFixed(1)}`).join('');
  const area = `${line}L${X(data.length - 1).toFixed(1)},${Y(lo)}L${X(0)},${Y(lo)}Z`;
  const up = data[data.length - 1].c >= data[0].c;
  const col = up ? '#0f7b46' : '#d23b3b';
  let extra = '';
  if (opts.avg) {
    const y = Y(opts.avg).toFixed(1);
    extra += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e08a00" stroke-width="1.4" stroke-dasharray="5 4"/>`;
    extra += `<text x="${W - padR}" y="${(+y - 4)}" text-anchor="end" font-size="11" fill="#e08a00">vốn ${Math.round(opts.avg).toLocaleString('vi-VN')}</text>`;
  }
  if (opts.markers) {
    const idxByDate = {}; data.forEach((d, i) => { idxByDate[d.t] = i; });
    for (const m of opts.markers) {
      // tìm phiên gần nhất >= ngày giao dịch
      let i = data.findIndex(d => d.t >= m.date); if (i < 0) i = data.length - 1;
      const mc = m.type === 'buy' ? '#0f7b46' : '#d23b3b';
      extra += `<circle cx="${X(i).toFixed(1)}" cy="${Y(data[i].c).toFixed(1)}" r="4.5" fill="${mc}" stroke="#fff" stroke-width="1.5"/>`;
    }
  }
  const lab = (v) => Math.round(v).toLocaleString('vi-VN');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${col}" stop-opacity="0.22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${extra}
    <text x="${padL}" y="${H - 6}" font-size="10" fill="#7a8794">${data[0].t}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="10" fill="#7a8794">${data[data.length - 1].t}</text>
    <text x="${padL}" y="${padT + 2}" font-size="10" fill="#7a8794">${lab(hi)}</text>
    <text x="${padL}" y="${H - padB}" font-size="10" fill="#7a8794">${lab(lo)}</text>
  </svg>`;
}

/* ---------- Nhiều đường (HPA vs VN-Index vs Ngành), rebase 100 ---------- */
function multiLineSVG(dates, lines) {
  const valid = lines.flatMap(l => l.vals).filter(v => v != null);
  if (!dates.length || !valid.length) return '<p class="muted small">Chưa có dữ liệu.</p>';
  const W = 520, H = 210, padL = 8, padR = 8, padT = 12, padB = 22;
  let lo = Math.min(...valid), hi = Math.max(...valid);
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const n = dates.length;
  const X = i => padL + (i / (n - 1 || 1)) * (W - padL - padR);
  const Y = v => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const y100 = Y(100).toFixed(1);
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<line x1="${padL}" y1="${y100}" x2="${W - padR}" y2="${y100}" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>`;
  svg += `<text x="${padL}" y="${(+y100 - 3)}" font-size="9" fill="#7a8794">100 (lúc bạn bắt đầu xem)</text>`;
  for (const l of lines) {
    let d = '', started = false;
    l.vals.forEach((v, i) => { if (v == null) return; d += (started ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1); started = true; });
    svg += `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.w || 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  svg += `<text x="${padL}" y="${H - 6}" font-size="10" fill="#7a8794">${dates[0]}</text>`;
  svg += `<text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="10" fill="#7a8794">${dates[n - 1]}</text>`;
  return svg + '</svg>';
}

function renderBenchmark() {
  const b = DATA.benchmark;
  if (!b || !(b.dates || []).length) { $('benchChart').innerHTML = '<p class="muted small">Chưa có dữ liệu so sánh.</p>'; $('benchLegend').innerHTML = ''; $('benchNote').textContent = ''; return; }
  const lines = [
    { name: 'HPA', color: '#0f7b46', vals: b.hpa, w: 2.4 },
    { name: 'VN-Index', color: '#8a97a3', vals: b.vnindex },
    { name: 'Ngành', color: '#e08a00', vals: b.industry },
  ];
  $('benchChart').innerHTML = multiLineSVG(b.dates, lines);
  const endPct = v => (v != null) ? signed(x => x.toFixed(1) + '%', v - 100) : '—';
  $('benchLegend').innerHTML = lines.map(l =>
    `<span style="color:${l.color}"><b style="display:inline-block;width:10px;height:3px;background:${l.color};border-radius:2px;vertical-align:middle;margin-right:5px"></b>${l.name} ${endPct(l.vals[l.vals.length - 1])}</span>`).join('');
  const hpaEnd = b.hpa[b.hpa.length - 1], indEnd = b.industry[b.industry.length - 1];
  const diff = (hpaEnd != null && indEnd != null) ? (hpaEnd - indEnd) : null;
  $('benchNote').textContent = `Rebase 100 từ phiên đầu (${b.dates[0]}). ` +
    (diff != null ? (diff < 0 ? `HPA đang thua ngành ${Math.abs(diff).toFixed(1)} điểm %.` : `HPA đang thắng ngành ${diff.toFixed(1)} điểm %.`) : '') +
    ` Chỉ số ngành = bình quân đều ${b.n_peers} mã cùng ngành.`;
}

/* ---------- Tín hiệu kỹ thuật ---------- */
function renderTechnical() {
  const t = DATA.technical;
  const badge = $('techBadge'), grid = $('techGrid'), sig = $('techSignals');
  if (!t || !t.signals) { badge.textContent = ''; grid.innerHTML = '<p class="muted small">Chưa có dữ liệu kỹ thuật.</p>'; sig.innerHTML = ''; return; }
  const vcls = v => v === 'tích cực' ? 'pos' : v === 'tiêu cực' ? 'neg' : 'neutral';
  badge.textContent = t.label;
  badge.className = 'techbadge ' + vcls(t.label.toLowerCase());
  grid.innerHTML = [
    ['RSI (14)', t.rsi ?? '—'],
    ['MACD', t.macd_hist != null ? (t.macd_hist > 0 ? 'cắt lên ▲' : 'cắt xuống ▼') : '—'],
    ['MA20', t.ma20 ? vnd(t.ma20) : '—'],
    ['MA50', t.ma50 ? vnd(t.ma50) : '—'],
    ['ADX', t.adx != null ? `${t.adx} (${t.trend_strength || ''})` : '—'],
    ['Giá hiện tại', vnd(DATA.current_price)],
  ].map(([k, v]) => `<div class="fg"><div class="fg-l">${k}</div><div class="fg-v">${v}</div></div>`).join('');
  sig.innerHTML = t.signals.map(s => `<div class="techsig">
      <span class="techsig-n">${s.name}</span>
      <span class="techsig-note muted small">${s.note || ''}</span>
      <span class="pill ${vcls(s.verdict)}">${s.verdict}</span>
    </div>`).join('');
}

/* ---------- Lãi/lỗ tích lũy theo thời gian ---------- */
function equitySeries() {
  const adjust = SETTINGS.adjustCostByDiv !== false;
  const hist = DATA.price_history || [];
  if (!TX.length || !hist.length) return [];
  const evs = [];
  for (const t of TX) evs.push({ date: t.date, ord: 1, tx: t });
  for (const d of (DATA.dividends || [])) if (d.ex_date && d.value) evs.push({ date: d.ex_date, ord: 0, div: d });
  evs.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord);
  let qty = 0, cost = 0, realized = 0, divNet = 0, ei = 0, started = false;
  const out = [];
  for (const bar of hist) {
    if (bar.c == null) continue;
    while (ei < evs.length && evs[ei].date <= bar.t) {
      const ev = evs[ei++];
      if (ev.tx) {
        const t = ev.tx, fee = txFee(t);
        if (t.type === 'buy') { cost += t.qty * t.price + fee; qty += t.qty; started = true; }
        else { const avg = qty > 0 ? cost / qty : 0; realized += t.qty * t.price - fee - t.qty * avg; cost -= t.qty * avg; qty -= t.qty; if (qty < 1e-6) { qty = 0; cost = 0; } }
      } else {
        const d = ev.div, sh = qty;
        if (sh > 0) { const net = Math.round(sh * d.value * (1 - SETTINGS.taxDiv / 100)); divNet += net; if (adjust) cost -= net; }
      }
    }
    if (started) {
      const value = qty * bar.c;
      const pnl = adjust ? (realized + value - cost) : (realized + value - cost + divNet);
      out.push({ t: bar.t, v: pnl });
    }
  }
  return out;
}

function pnlChartSVG(data) {
  if (!data.length) return '<p class="muted small">Chưa có giao dịch để vẽ.</p>';
  const W = 520, H = 170, padL = 8, padR = 8, padT = 14, padB = 22;
  const vs = data.map(d => d.v);
  let lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
  const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad;
  const n = data.length;
  const X = i => padL + (i / (n - 1 || 1)) * (W - padL - padR);
  const Y = v => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const y0 = Y(0).toFixed(1);
  const last = data[n - 1].v, col = last >= 0 ? '#0f7b46' : '#d23b3b';
  const line = data.map((d, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(d.v).toFixed(1)).join('');
  const area = `${line}L${X(n - 1).toFixed(1)},${y0}L${X(0).toFixed(1)},${y0}Z`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="gp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#gp)"/>
    <line x1="${padL}" y1="${y0}" x2="${W - padR}" y2="${y0}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 3"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="${padL}" y="${H - 6}" font-size="10" fill="#7a8794">${data[0].t}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="10" fill="#7a8794">${data[n - 1].t}</text>
  </svg>`;
}

function renderEquity() {
  const card = $('equityCard');
  const series = equitySeries();
  if (!series.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  $('equityChart').innerHTML = pnlChartSVG(series);
  const last = series[series.length - 1].v;
  const peak = Math.max(...series.map(s => s.v)), trough = Math.min(...series.map(s => s.v));
  $('equityLegend').innerHTML = `<span class="${cls(last)}">Hiện tại ${signed(money, last)}</span>` +
    `<span class="muted">Cao nhất ${money(peak)}</span><span class="muted">Thấp nhất ${money(trough)}</span>`;
}

/* ---------- Hòa vốn + mua bình quân (DCA) ---------- */
function renderBreakeven() {
  const p = computePortfolio();
  const sellCost = (SETTINGS.feeSell + SETTINGS.taxSell) / 100;
  const be = p.qty ? p.avgCost / (1 - sellCost) : 0;
  $('breakevenInfo').innerHTML = p.qty ? [
    ['CP đang giữ', p.qty.toLocaleString('vi-VN')],
    ['Giá vốn TB', vnd(p.avgCost)],
    ['Giá hòa vốn (gồm phí bán)', vnd(be)],
    ['Giá hiện tại', vnd(p.price)],
    ['Cần tăng để hòa vốn', p.price ? signed(x => pct(x, 1), (be / p.price - 1) * 100) : '—'],
  ].map(([k, v]) => `<div class="fact"><span class="muted">${k}</span><b>${v}</b></div>`).join('')
    : '<p class="muted small">Chưa có CP. Nhập lệnh mua ở trên để tính hòa vốn.</p>';
  calcDCA();
}
function calcDCA() {
  const p = computePortfolio();
  const q = parseInt($('dcaQty').value, 10), pr = parseFloat($('dcaPrice').value);
  if (!q || !pr) { $('dcaResult').innerHTML = ''; return; }
  const fee = Math.round(q * pr * SETTINGS.feeBuy / 100);
  const newQty = p.qty + q;
  const newCost = p.cost + q * pr + fee;
  const newAvg = newQty > 0 ? newCost / newQty : 0;
  const be = newAvg / (1 - (SETTINGS.feeSell + SETTINGS.taxSell) / 100);
  $('dcaResult').innerHTML = '<div class="fact"><span class="muted">— Nếu mua thêm —</span><b></b></div>' + [
    ['Tiền cần', vnd(q * pr + fee)],
    ['CP sau mua', newQty.toLocaleString('vi-VN')],
    ['Giá vốn TB mới', vnd(newAvg)],
    ['Giá hòa vốn mới', vnd(be)],
  ].map(([k, v]) => `<div class="fact"><span class="muted">${k}</span><b>${v}</b></div>`).join('');
}

/* ---------- Sự kiện sắp tới + tin tức ---------- */
function renderNews() {
  const tDay = today();
  const upcoming = (DATA.events || []).filter(e => e.date && e.date >= tDay)
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const el = $('eventList');
  if (!upcoming.length) {
    const recent = (DATA.events || []).filter(e => e.date).sort((a, b) => a.date < b.date ? 1 : -1)[0];
    el.innerHTML = '<p class="muted small">Chưa có sự kiện sắp tới được công bố.' +
      (recent ? ` Gần nhất: ${recent.title || recent.name} (${recent.date}).` : '') + '</p>';
  } else {
    el.innerHTML = upcoming.map(e => {
      const days = Math.max(0, Math.ceil((new Date(e.date) - new Date(tDay)) / 86400000));
      return `<div class="dv"><div class="dv-l"><b>${e.title || e.name}</b><div class="muted small">${e.date}</div></div>
        <div class="dv-r"><span class="tag up">còn ${days} ngày</span></div></div>`;
    }).join('');
  }
  const nl = $('newsList');
  const news = DATA.news || [];
  nl.innerHTML = news.length ? news.map(n => {
    const title = n.url ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>` : n.title;
    return `<div class="news"><div class="news-t">${title}</div><div class="muted small">${n.date || ''}${n.source ? ' · ' + n.source : ''}</div></div>`;
  }).join('') : '<p class="muted small">Chưa có tin tức.</p>';
}

/* ===================== Events ===================== */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(s => s.hidden = (s.id !== 'tab-' + name));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'chart') renderChart();
  window.scrollTo(0, 0);
}

function setTxType(t) {
  txType = t;
  document.querySelectorAll('#txTypeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.type === t));
  $('txSubmit').textContent = (editingId ? 'Lưu lệnh ' : 'Thêm lệnh ') + (t === 'buy' ? 'MUA' : 'BÁN');
  $('feeHint').textContent = `(tự tính ~${t === 'buy' ? SETTINGS.feeBuy : (SETTINGS.feeSell + SETTINGS.taxSell)}%)`;
}

function submitTx(e) {
  e.preventDefault();
  const date = $('txDate').value || today();
  const qty = parseInt($('txQty').value, 10);
  const price = parseFloat($('txPrice').value);
  const feeRaw = $('txFee').value;
  if (!qty || !price) return;
  const fee = feeRaw === '' ? null : parseInt(feeRaw, 10);
  if (editingId) {
    const t = TX.find(x => x.id === editingId);
    Object.assign(t, { date, type: txType, qty, price, fee });
    editingId = null; $('txCancel').style.display = 'none';
  } else {
    TX.push({ id: uid(), date, type: txType, qty, price, fee });
  }
  saveTx(); $('txForm').reset(); $('txDate').value = today(); setTxType('buy');
  renderAll();
}

function editTx(id) {
  const t = TX.find(x => x.id === id); if (!t) return;
  editingId = id;
  $('txDate').value = t.date; $('txQty').value = t.qty; $('txPrice').value = t.price;
  $('txFee').value = t.fee == null ? '' : t.fee;
  setTxType(t.type);
  $('txCancel').style.display = 'block';
  $('txSubmit').textContent = 'Lưu lệnh ' + (t.type === 'buy' ? 'MUA' : 'BÁN');
  window.scrollTo(0, 0);
}
function delTx(id) {
  if (!confirm('Xóa lệnh này?')) return;
  TX = TX.filter(x => x.id !== id); saveTx(); renderAll();
}

function exportData() {
  const blob = new Blob([JSON.stringify({ tx: TX, settings: SETTINGS }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'hpa-so-giao-dich-' + today() + '.json'; a.click();
}
function importData(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const o = JSON.parse(fr.result);
      if (Array.isArray(o.tx)) { TX = o.tx.map(t => ({ id: t.id || uid(), ...t })); saveTx(); }
      if (o.settings) { SETTINGS = { ...DEFAULT_SETTINGS, ...o.settings }; saveSettings(); }
      renderAll(); alert('Đã nhập ' + TX.length + ' lệnh.');
    } catch { alert('File không hợp lệ.'); }
  };
  fr.readAsText(file);
}

function renderAll() { renderOverview(); renderTrades(); renderDividends(); renderFundamentals();
  if (!$('tab-chart').hidden) renderChart(); }

/* ===================== Init ===================== */
async function init() {
  loadState();
  await loadData();
  renderHeader();
  renderAll();
  $('txDate').value = today();

  // nav
  document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  document.querySelectorAll('#txTypeSeg .seg-btn').forEach(b => b.onclick = () => setTxType(b.dataset.type));
  document.querySelectorAll('#adjSeg .seg-btn').forEach(b => b.onclick = () => {
    adjMode = b.dataset.adj;
    document.querySelectorAll('#adjSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    renderChart();
  });
  $('txForm').onsubmit = submitTx;
  $('txCancel').onclick = () => { editingId = null; $('txForm').reset(); $('txDate').value = today(); setTxType('buy'); $('txCancel').style.display = 'none'; };
  $('txList').onclick = (e) => {
    const del = e.target.closest('[data-del]'); if (del) return delTx(del.dataset.del);
    const ed = e.target.closest('[data-edit]'); if (ed) return editTx(ed.dataset.edit);
  };
  $('saveSettings').onclick = () => {
    SETTINGS = { feeBuy: +$('setFeeBuy').value, feeSell: +$('setFeeSell').value,
                 taxSell: +$('setTaxSell').value, taxDiv: +$('setTaxDiv').value,
                 adjustCostByDiv: $('setAdjustDiv').checked };
    saveSettings(); renderAll(); alert('Đã lưu cài đặt.');
  };
  $('exportBtn').onclick = exportData;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); };
  $('dcaQty').oninput = calcDCA; $('dcaPrice').oninput = calcDCA;

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }
}
document.addEventListener('DOMContentLoaded', init);

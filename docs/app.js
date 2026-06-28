/* HPA · Sổ đầu tư — logic toàn bộ (vanilla JS, lưu localStorage) */
'use strict';

const KEY_TX = 'hpa_tx_v1';
const KEY_SET = 'hpa_settings_v1';
const KEY_DATA = 'hpa_data_cache_v1';

const DEFAULT_SETTINGS = { feeBuy: 0.15, feeSell: 0.15, taxSell: 0.10, taxDiv: 5.0 };

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
const today = () => new Date().toISOString().slice(0, 10);

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

function computePortfolio() {
  let qty = 0, cost = 0, realized = 0, buyCostSum = 0, sellProceeds = 0;
  for (const t of sortedTx()) {
    const fee = txFee(t);
    if (t.type === 'buy') {
      cost += t.qty * t.price + fee; qty += t.qty; buyCostSum += t.qty * t.price + fee;
    } else {
      const avg = qty > 0 ? cost / qty : 0;
      const proceeds = t.qty * t.price - fee;
      realized += proceeds - t.qty * avg;
      cost -= t.qty * avg; qty -= t.qty; sellProceeds += proceeds;
      if (qty < 1e-6) { qty = 0; cost = 0; }
    }
  }
  const price = DATA?.current_price || 0;
  const avgCost = qty > 0 ? cost / qty : 0;
  const marketValue = qty * price;
  const unreal = marketValue - cost;
  const div = computeDividends();
  const totalReturn = realized + unreal + div.netReceived;
  const roi = buyCostSum > 0 ? totalReturn / buyCostSum * 100 : 0;
  return { qty, avgCost, cost, marketValue, unreal,
           unrealPct: cost > 0 ? unreal / cost * 100 : 0,
           realized, buyCostSum, sellProceeds, div, totalReturn, roi, price };
}

function netSharesBefore(dateStr) {
  let q = 0;
  for (const t of TX) if (t.date < dateStr) q += (t.type === 'buy' ? t.qty : -t.qty);
  return Math.max(0, q);
}

function computeDividends() {
  const out = { detail: [], grossReceived: 0, netReceived: 0, grossUpcoming: 0, netUpcoming: 0 };
  const divs = (DATA?.dividends || []).filter(d => d.ex_date && d.value);
  for (const d of divs) {
    const shares = netSharesBefore(d.ex_date);
    if (shares <= 0) continue;
    const gross = shares * d.value;
    const net = Math.round(gross * (1 - SETTINGS.taxDiv / 100));
    const paid = d.pay_date && d.pay_date <= today();
    out.detail.push({ ...d, shares, gross, net, paid });
    if (paid) { out.grossReceived += gross; out.netReceived += net; }
    else { out.grossUpcoming += gross; out.netUpcoming += net; }
  }
  return out;
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
  $('sAvgSub').textContent = p.qty ? `hiện ${vnd(p.price)}` : '';

  setStat('sUnreal', p.unreal, money); $('sUnrealPct').textContent = p.qty ? signed(x => pct(x), p.unrealPct) : '';
  setStat('sReal', p.realized, money);
  $('sDiv').textContent = money(p.div.netReceived); $('sDiv').className = 'stat-val ' + (p.div.netReceived > 0 ? 'pos' : '');
  $('sDivSub').textContent = p.div.netUpcoming > 0 ? 'sắp nhận ' + money(p.div.netUpcoming) : 'sau thuế';
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
}

function renderDividends() {
  const d = computeDividends();
  $('divTotal').textContent = money(d.netReceived);
  $('divTotalSub').textContent = d.grossReceived ? `Trước thuế ${money(d.grossReceived)} · thuế ${SETTINGS.taxDiv}%` : 'Chưa nhận cổ tức nào';
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
                 taxSell: +$('setTaxSell').value, taxDiv: +$('setTaxDiv').value };
    saveSettings(); renderAll(); alert('Đã lưu cài đặt.');
  };
  $('exportBtn').onclick = exportData;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); };

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }
}
document.addEventListener('DOMContentLoaded', init);

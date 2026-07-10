# -*- coding: utf-8 -*-
"""
update_hpa.py  --  Lay du lieu HPA tu vnstock va ghi ra docs/data/hpa.json
Chay dinh ky bang Windows Task Scheduler. Sau khi ghi xong se git add/commit/push
(neu chay voi tham so --push) de GitHub Pages tu cap nhat.

Usage:
    python update_hpa.py            # chi cap nhat hpa.json
    python update_hpa.py --push     # cap nhat + git commit + push
"""
import os
import sys
import io
import json
import math
import warnings
from datetime import datetime, date, timezone, timedelta

# --- ep UTF-8 cho stdout (tranh loi charmap tren Windows) ---
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass
warnings.filterwarnings("ignore")

SYMBOL = "HPA"
SOURCE = "VCI"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "hpa.json")
VN_TZ = timezone(timedelta(hours=7))

# So peer toi da lay (cung nganh) de so sanh
MAX_PEERS = 12
# Cap nhat nganh nay (icb_code 3500 = Thuc pham va do uong, ICB level 2)
PEER_INDUSTRY_CODE = "3500"


def log(*a):
    print("[update_hpa]", *a, flush=True)


def num(x):
    """ep ve so float JSON-safe, NaN/inf -> None"""
    try:
        if x is None:
            return None
        f = float(x)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def get_stock(symbol=None):
    """Tra ve object co .quote/.company/.listing/.finance - dung vnstock_data (paid) neu co,
    fallback ve wrapper Vnstock() cua goi vnstock (free) neu khong.
    LUU Y: .finance luon dung vnstock (free) - schema cua vnstock_data.Finance.ratio()
    khac hoan toan (wide-format pe/pb/roe truc tiep) so voi item_en long-format ma
    ratio_kv() dang doc, con vnstock (free) Finance.ratio() van tra dung item_en."""
    sym = symbol or SYMBOL
    try:
        from vnstock_data.api.quote import Quote
        from vnstock_data.api.company import Company
        from vnstock_data.api.listing import Listing
        from vnstock.api.financial import Finance

        class _Stock:
            quote = Quote(symbol=sym, source=SOURCE)
            company = Company(symbol=sym, source=SOURCE)
            listing = Listing(source=SOURCE)
            finance = Finance(source=SOURCE, symbol=sym)
        return _Stock()
    except Exception:
        from vnstock import Vnstock
        return Vnstock().stock(symbol=sym, source=SOURCE)


# ----------------------------------------------------------------------------
def get_history_df(s):
    """Lay DataFrame OHLCV ngay (dung cho ca price_history lan chi bao ky thuat)."""
    return s.quote.history(start="2015-01-01", end=date.today().isoformat(), interval="1D")


def df_to_rows(df):
    """Chuyen df OHLCV -> list dict (gia *1000 VND)."""
    rows = []
    for _, r in df.iterrows():
        t = r["time"]
        t = t.strftime("%Y-%m-%d") if hasattr(t, "strftime") else str(t)[:10]
        rows.append({
            "t": t,
            "o": num(r["open"]) and round(num(r["open"]) * 1000),
            "h": num(r["high"]) and round(num(r["high"]) * 1000),
            "l": num(r["low"]) and round(num(r["low"]) * 1000),
            "c": round(num(r["close"]) * 1000) if num(r["close"]) is not None else None,
            "v": int(num(r["volume"]) or 0),
        })
    return rows


def fetch_technical(df):
    """Tinh tin hieu ky thuat tu vnstock_ta (RSI, MACD, MA20/50, ADX) + tong hop."""
    out = {}
    try:
        from vnstock_ta import Indicator
        I = Indicator(df)
        price = num(df["close"].iloc[-1]) * 1000
        rsi = num(I.rsi(length=14).iloc[-1])
        macd = I.macd()
        macd_line = num(macd["MACD_12_26_9"].iloc[-1])
        macd_sig = num(macd["MACDs_12_26_9"].iloc[-1])
        macd_hist = num(macd["MACDh_12_26_9"].iloc[-1])
        ma20 = num(I.sma(length=20).iloc[-1])
        ma50 = num(I.sma(length=50).iloc[-1])
        ma20 = round(ma20 * 1000) if ma20 else None
        ma50 = round(ma50 * 1000) if ma50 else None
        try:
            adx = num(I.adx()["ADX_14"].iloc[-1])
        except Exception:
            adx = None

        signals = []
        # RSI
        if rsi is not None:
            if rsi >= 70:
                signals.append(("RSI", round(rsi, 1), "tiêu cực", "quá mua (>70)"))
            elif rsi <= 30:
                signals.append(("RSI", round(rsi, 1), "tích cực", "quá bán (<30)"))
            else:
                signals.append(("RSI", round(rsi, 1), "trung tính", "vùng cân bằng"))
        # MACD
        if macd_hist is not None:
            signals.append(("MACD", None, "tích cực" if macd_hist > 0 else "tiêu cực",
                            "cắt lên đường tín hiệu" if macd_hist > 0 else "cắt xuống đường tín hiệu"))
        # MA20 / MA50
        if ma20 and price:
            signals.append(("Giá vs MA20", None, "tích cực" if price >= ma20 else "tiêu cực",
                            ("trên" if price >= ma20 else "dưới") + " MA20 " + f"{ma20:,}".replace(",", ".")))
        if ma50 and price:
            signals.append(("Giá vs MA50", None, "tích cực" if price >= ma50 else "tiêu cực",
                            ("trên" if price >= ma50 else "dưới") + " MA50 " + f"{ma50:,}".replace(",", ".")))

        score = sum(1 if s[2] == "tích cực" else -1 if s[2] == "tiêu cực" else 0 for s in signals)
        label = "Tích cực" if score >= 2 else "Tiêu cực" if score <= -2 else "Trung tính"
        trend = None
        if adx is not None:
            trend = "mạnh" if adx >= 25 else "yếu" if adx < 20 else "vừa"
        out = {
            "rsi": round(rsi, 1) if rsi is not None else None,
            "macd": round(macd_line, 3) if macd_line is not None else None,
            "macd_hist": round(macd_hist, 3) if macd_hist is not None else None,
            "ma20": ma20, "ma50": ma50,
            "adx": round(adx, 1) if adx is not None else None,
            "trend_strength": trend,
            "signals": [{"name": n, "value": v, "verdict": vd, "note": nt} for (n, v, vd, nt) in signals],
            "score": score, "label": label,
        }
    except Exception as e:
        log("technical err:", e)
    return out


def fetch_current_price(s, hist):
    """Gia hien tai: uu tien intraday 1m gan nhat, fallback close ngay gan nhat."""
    last_close = hist[-1]["c"] if hist else None
    prev_close = hist[-2]["c"] if len(hist) >= 2 else last_close
    cur = last_close
    try:
        intr = s.quote.history(
            start=(date.today() - timedelta(days=5)).isoformat(),
            end=date.today().isoformat(),
            interval="1m",
        )
        if intr is not None and len(intr):
            cur = round(num(intr["close"].iloc[-1]) * 1000)
    except Exception as e:
        log("intraday khong lay duoc, dung close ngay:", e)
    return cur, prev_close


def fetch_overview(s):
    try:
        ov = s.company.overview()
        d = ov.iloc[0].to_dict() if len(ov) else {}
        return d
    except Exception as e:
        log("overview err:", e)
        return {}


def ratio_kv(st, mcap):
    """Doc finance.ratio va tra ve dict {item_en: gia_tri_nam_hien_tai}.

    VCI doi khi tra ve cac cot nam bi TRUNG TEN (vd nhieu cot '2018') khien
    chon theo ten cot bi sai. Cach chac chan: chon cot co dong 'Market Cap'
    gan nhat voi market cap hien tai (overview) -> do la nam moi nhat.
    """
    try:
        r = st.finance.ratio(period="year", lang="en")
    except Exception as e:
        log("ratio err:", e)
        return {}
    if "item_en" not in r.columns:
        return {}
    items = r["item_en"].astype(str).tolist()
    vals = r.iloc[:, 3:]  # bo 3 cot dau item/item_en/item_id, lay positional
    if vals.shape[1] == 0:
        return {}
    best = 0
    if mcap and "Market Cap" in items:
        mi = items.index("Market Cap")
        row = vals.iloc[mi].tolist()
        diffs = [(abs(float(x) - mcap), j) for j, x in enumerate(row)
                 if isinstance(x, (int, float)) and x == x]
        if diffs:
            best = min(diffs)[1]
    col = vals.iloc[:, best]
    return dict(zip(items, col.tolist()))


def fetch_fundamentals(s, mcap, current_price):
    """Map cac chi so co ban tu finance.ratio (item_en -> value)."""
    out = {}
    try:
        kv = ratio_kv(s, mcap)
        # phan tram -> nhan 100
        def pct(name):
            v = num(kv.get(name))
            return round(v * 100, 2) if v is not None else None
        out = {
            "pe": round(num(kv.get("P/E")), 2) if num(kv.get("P/E")) else None,
            "pb": round(num(kv.get("P/B")), 2) if num(kv.get("P/B")) else None,
            "ps": round(num(kv.get("P/S")), 2) if num(kv.get("P/S")) else None,
            "ev_ebitda": round(num(kv.get("EV/EBITDA")), 2) if num(kv.get("EV/EBITDA")) else None,
            "div_yield": pct("Dividend Yield (%)"),
            "roe": pct("ROE (%)"),
            "roa": pct("ROA (%)"),
            "gross_margin": pct("Gross Margin (%)"),
            "net_margin": pct("After-tax Profit Margin (%)"),
            "current_ratio": round(num(kv.get("Current Ratio")), 2) if num(kv.get("Current Ratio")) else None,
            "debt_equity": round(num(kv.get("Debt to Equity")), 2) if num(kv.get("Debt to Equity")) else None,
        }
        # EPS & BVPS suy ra tu gia / PE, gia / PB
        if out["pe"] and current_price:
            out["eps"] = round(current_price / out["pe"])
        if out["pb"] and current_price:
            out["bvps"] = round(current_price / out["pb"])
    except Exception as e:
        log("fundamentals err:", e)
    return out


def fetch_dividends(s):
    """Lay lich su co tuc tien mat tu company.events() (event_code == DIV)."""
    out = []
    try:
        ev = s.company.events()
        if ev is None or not len(ev):
            return out
        df = ev[ev["event_code"] == "DIV"].copy() if "event_code" in ev.columns else ev
        for _, r in df.iterrows():
            val = num(r.get("value_per_share"))
            if not val:  # bo qua su kien khong phai tra tien (value 0/None)
                continue
            ex = r.get("exright_date") or r.get("record_date")
            ex = str(ex)[:10] if ex is not None else None
            pay = r.get("payout_date")
            pay = str(pay)[:10] if pay is not None and str(pay) != "nan" else None
            title = r.get("event_title_vi") or ""
            yr = None
            for tok in str(title).split():
                if tok.isdigit() and len(tok) == 4:
                    yr = int(tok)
            out.append({
                "year": yr,
                "value": round(val),
                "ratio": num(r.get("exercise_ratio")),
                "ex_date": ex,
                "pay_date": pay,
                "title": str(title),
            })
        # sap xep theo ex_date giam dan
        out.sort(key=lambda x: x["ex_date"] or "", reverse=True)
    except Exception as e:
        log("dividends err:", e)
    return out


def adjusted_history(hist, dividends):
    """Tinh gia dieu chinh theo co tuc (back-adjust) -- chi co tuc co ex_date nam
    trong khoang lich su gia moi anh huong."""
    if not hist:
        return []
    closes = {h["t"]: h["c"] for h in hist if h["c"]}
    times = [h["t"] for h in hist]
    # he so dieu chinh tich luy: voi moi ex_date, factor = 1 - div/close_truoc_ex
    factors = []  # (ex_date, factor)
    for d in dividends:
        ex = d.get("ex_date")
        if not ex or ex < times[0] or ex > times[-1]:
            continue
        # close cua phien lien truoc ex_date
        before = [t for t in times if t < ex]
        if not before:
            continue
        c_before = closes.get(before[-1])
        if not c_before:
            continue
        f = 1.0 - (d["value"] / c_before)
        if 0 < f < 1:
            factors.append((ex, f))
    out = []
    for h in hist:
        c = h["c"]
        if c is None:
            out.append({"t": h["t"], "c": None})
            continue
        adj = c
        for ex, f in factors:
            if h["t"] < ex:  # gia truoc ex duoc nhan he so
                adj *= f
        out.append({"t": h["t"], "c": round(adj)})
    return out


def fetch_peers(start_date):
    """Lay peer cung nganh (ICB icb_code) + chi so so sanh + lich su gia (dung chi so nganh).

    symbols_by_industries() cua vnstock.api.listing.Listing tra ve icb_code/icb_name
    (khong phai industry_code kieu cu tu Vnstock().stock().listing da deprecated),
    moi symbol co nhieu dong (1 dong / icb_level 1-4) nen loc truc tiep theo icb_code
    la du, khong can loc them theo icb_level.

    Tra ve (peers, peer_hist) voi peer_hist = {symbol: {date: close}}.
    """
    peers = []
    peer_hist = {}
    try:
        listing = get_stock().listing
        sym = listing.symbols_by_industries()
        same = sym[sym["icb_code"].astype(str) == PEER_INDUSTRY_CODE]
        syms = [x for x in same["symbol"].tolist() if x != SYMBOL]
        syms = [x for x in syms if len(str(x)) == 3][:MAX_PEERS]
        for code in syms:
            try:
                st = get_stock(code)
                ov = st.company.overview()
                d = ov.iloc[0].to_dict() if len(ov) else {}
                mcap = num(d.get("market_cap"))
                kv = ratio_kv(st, mcap)
                roe = num(kv.get("ROE (%)"))
                peers.append({
                    "symbol": code,
                    "name": str(d.get("organ_short_name") or code),
                    "price": round(num(d.get("current_price"))) if num(d.get("current_price")) else None,
                    "market_cap": num(d.get("market_cap")),
                    "pe": round(num(kv.get("P/E")), 2) if num(kv.get("P/E")) else None,
                    "pb": round(num(kv.get("P/B")), 2) if num(kv.get("P/B")) else None,
                    "roe": round(roe * 100, 2) if roe is not None else None,
                })
                # lich su gia peer de dung chi so nganh
                try:
                    h = st.quote.history(start=start_date, end=date.today().isoformat(), interval="1D")
                    peer_hist[code] = {
                        (r["time"].strftime("%Y-%m-%d") if hasattr(r["time"], "strftime") else str(r["time"])[:10]):
                        num(r["close"]) for _, r in h.iterrows() if num(r["close"])
                    }
                except Exception:
                    pass
            except Exception as e:
                log(f"peer {code} skip:", e)
        peers.sort(key=lambda x: x["market_cap"] or 0, reverse=True)
    except Exception as e:
        log("peers err:", e)
    return peers, peer_hist


def fetch_vnindex(start_date):
    """Lay lich su VNINDEX -> {date: close}."""
    out = {}
    try:
        vi = get_stock("VNINDEX").quote.history(
            start=start_date, end=date.today().isoformat(), interval="1D")
        for _, r in vi.iterrows():
            t = r["time"]
            t = t.strftime("%Y-%m-%d") if hasattr(t, "strftime") else str(t)[:10]
            c = num(r["close"])
            if c:
                out[t] = c
    except Exception as e:
        log("vnindex err:", e)
    return out


def build_benchmark(hist, vnindex, peer_hist):
    """Dung 3 duong rebase ve 100 tren cung khung ngay cua HPA:
    HPA, VN-Index, va chi so Nganh (binh quan deu cac peer)."""
    dates = [h["t"] for h in hist if h["c"]]
    hpa_c = {h["t"]: h["c"] for h in hist if h["c"]}
    if not dates:
        return {}
    base_hpa = hpa_c[dates[0]]
    # VN-Index: forward-fill va rebase
    vi_series, last_vi, base_vi = [], None, None
    for t in dates:
        if t in vnindex:
            last_vi = vnindex[t]
        if base_vi is None and last_vi:
            base_vi = last_vi
        vi_series.append(round(last_vi / base_vi * 100, 2) if (last_vi and base_vi) else None)
    # Nganh: moi peer rebase ve gia tri tai ngay dau co du lieu, roi binh quan deu
    peer_base = {}
    ind_series = []
    for t in dates:
        vals = []
        for code, hh in peer_hist.items():
            if t in hh:
                if code not in peer_base:
                    peer_base[code] = hh[t]
                vals.append(hh[t] / peer_base[code] * 100)
        ind_series.append(round(sum(vals) / len(vals), 2) if vals else None)
    hpa_series = [round(hpa_c[t] / base_hpa * 100, 2) for t in dates]
    return {
        "dates": dates,
        "hpa": hpa_series,
        "vnindex": vi_series,
        "industry": ind_series,
        "n_peers": len(peer_hist),
    }


def fetch_news(s, limit=12):
    """Tin tuc gan day ve HPA tu company.news()."""
    out = []
    try:
        n = s.company.news()
        if n is None or not len(n):
            return out
        for _, r in n.head(limit).iterrows():
            title = r.get("news_title") or r.get("friendly_title")
            pd_ = r.get("public_date")
            # public_date co the la epoch ms hoac chuoi
            ds = None
            try:
                if pd_ is not None and str(pd_).isdigit():
                    ds = datetime.fromtimestamp(int(pd_) / 1000, VN_TZ).strftime("%Y-%m-%d")
                elif pd_ is not None:
                    ds = str(pd_)[:10]
            except Exception:
                ds = str(pd_)[:10] if pd_ is not None else None
            out.append({
                "title": str(title).strip() if title else "",
                "date": ds,
                "source": str(r.get("news_source") or "").strip(),
                "url": str(r.get("news_source_link") or "").strip(),
            })
    except Exception as e:
        log("news err:", e)
    return out


def fetch_events_all(s, limit=12):
    """Cac su kien doanh nghiep (DH co dong, co tuc, niem yet...) cho phan nhac lich."""
    out = []
    try:
        ev = s.company.events()
        if ev is None or not len(ev):
            return out
        for _, r in ev.head(limit).iterrows():
            d = r.get("exright_date") or r.get("public_date") or r.get("display_date1")
            d = str(d)[:10] if d is not None and str(d) != "nan" else None
            out.append({
                "name": str(r.get("event_name_vi") or "").strip(),
                "title": str(r.get("event_title_vi") or "").strip(),
                "code": str(r.get("event_code") or "").strip(),
                "date": d,
            })
    except Exception as e:
        log("events err:", e)
    return out


def compute_cycle(hist):
    """Thong tin chu ky / swing don gian tu lich su gia (du lieu con ngan)."""
    closes = [h["c"] for h in hist if h["c"]]
    if not closes:
        return {}
    hi = max(closes)
    lo = min(closes)
    cur = closes[-1]
    # drawdown hien tai tu dinh
    peak = closes[0]
    max_dd = 0.0
    for c in closes:
        peak = max(peak, c)
        dd = (c - peak) / peak
        max_dd = min(max_dd, dd)
    cur_dd = (cur - hi) / hi if hi else 0
    return {
        "bars": len(closes),
        "high": hi,
        "low": lo,
        "from_high_pct": round(cur_dd * 100, 1),
        "max_drawdown_pct": round(max_dd * 100, 1),
        "range_pct": round((hi - lo) / lo * 100, 1) if lo else None,
        "note": "Lịch sử niêm yết còn ngắn (~{} phiên) nên đây chỉ là biến động ngắn hạn, chưa đủ để xác định chu kỳ dài hạn.".format(len(closes)),
    }


def setup_vnstock_key():
    """Nap API key vnstock: uu tien bien moi truong VNSTOCK_API_KEY, sau do
    file updater/vnstock_key.txt (khong commit). Neu khong co, dung key da dang ky
    san trong ~/.vnstock/api_key.json."""
    key = os.getenv("VNSTOCK_API_KEY")
    if not key:
        kf = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vnstock_key.txt")
        if os.path.exists(kf):
            try:
                with open(kf, encoding="utf-8") as f:
                    key = f.read().strip()
            except Exception:
                key = None
    if key and not key.startswith("#") and len(key) >= 10:
        os.environ["VNSTOCK_API_KEY"] = key  # vnai uu tien doc bien nay
    # bao cao tier dang dung
    try:
        import vnai
        st = vnai.check_api_key_status()
        log("vnstock tier:", st.get("tier"), "| limits:", st.get("limits"))
    except Exception:
        pass


def vn_now():
    """Gio Viet Nam (UTC+7) — KHONG phu thuoc mui gio cua may."""
    return datetime.now(VN_TZ)


def vn_today():
    return vn_now().strftime("%Y-%m-%d")


def vn_market_open():
    """True neu dang trong phien giao dich HOSE (gio VN): T2-T6,
    sang 9:00-11:30, chieu 13:00-15:00."""
    now = vn_now()
    if now.weekday() >= 5:  # T7/CN
        return False
    t = now.hour * 60 + now.minute
    return (9 * 60 <= t <= 11 * 60 + 30) or (13 * 60 <= t <= 15 * 60 + 1)


MARKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".last_full_date")


def _read_marker():
    try:
        with open(MARKER, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _write_marker(d):
    try:
        with open(MARKER, "w", encoding="utf-8") as f:
            f.write(d)
    except Exception:
        pass


def load_existing():
    """Doc hpa.json hien co (cho che do --light)."""
    try:
        with open(OUT, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    auto = "--auto" in sys.argv
    force = "--force" in sys.argv
    light = "--light" in sys.argv
    do_full_marker = False

    # --auto: tu quyet dinh full/light/skip theo GIO VIET NAM (truoc khi import vnstock)
    if auto:
        full_due = (_read_marker() != vn_today()) and vn_now().hour >= 8
        if full_due:
            light = False
            do_full_marker = True
            log("auto -> FULL update (lan dau trong ngay, gio VN", vn_now().strftime("%H:%M") + ")")
        elif vn_market_open() or force:
            light = True
            log("auto -> LIGHT update (gio giao dich VN", vn_now().strftime("%H:%M") + ")")
        else:
            log("auto -> BO QUA (ngoai gio giao dich VN, hien", vn_now().strftime("%a %H:%M") + ")")
            return

    log("bat dau cap nhat", SYMBOL, "(light)" if light else "(full)")
    setup_vnstock_key()
    s = get_stock()
    df = get_history_df(s)
    hist = df_to_rows(df)
    log("price history:", len(hist), "phien")
    start_date = hist[0]["t"] if hist else "2026-02-01"
    cur, prev = fetch_current_price(s, hist)
    technical = fetch_technical(df)
    log("technical:", technical.get("label"), "| RSI", technical.get("rsi"))

    change = cur - prev if (cur is not None and prev) else None
    change_pct = round(change / prev * 100, 2) if (change is not None and prev) else None

    if light:
        # Che do nhe: chi lam moi GIA + KY THUAT, giu nguyen phan nang (peers/benchmark/news...)
        data = load_existing()
        divs = data.get("dividends", [])
        data.update({
            "updated_at": datetime.now(VN_TZ).isoformat(timespec="seconds"),
            "current_price": cur, "prev_close": prev, "change": change, "change_pct": change_pct,
            "price_history": hist,
            "adj_history": adjusted_history(hist, divs),
            "cycle": compute_cycle(hist),
            "technical": technical,
        })
        log("light: chi cap nhat gia + ky thuat (giu peers/benchmark/news cu)")
    else:
        ov = fetch_overview(s)
        fund = fetch_fundamentals(s, num(ov.get("market_cap")), cur)
        divs = fetch_dividends(s)
        log("dividends:", len(divs))
        peers, peer_hist = fetch_peers(start_date)
        log("peers:", len(peers))
        vnindex = fetch_vnindex(start_date)
        benchmark = build_benchmark(hist, vnindex, peer_hist)
        log("benchmark dates:", len(benchmark.get("dates", [])), "| peers in index:", benchmark.get("n_peers"))
        news = fetch_news(s)
        log("news:", len(news))
        events = fetch_events_all(s)
        data = {
            "symbol": SYMBOL,
            "name": str(ov.get("organ_name") or "CTCP Phat trien Nong nghiep Hoa Phat"),
            "short_name": str(ov.get("organ_short_name") or "Nong nghiep Hoa Phat"),
            "exchange": "HOSE",
            "sector": str(ov.get("sector") or "Nong - Lam - Ngu"),
            "listing_date": str(ov.get("listing_date") or "2026-02-06")[:10],
            "updated_at": datetime.now(VN_TZ).isoformat(timespec="seconds"),
            "current_price": cur,
            "prev_close": prev,
            "change": change,
            "change_pct": change_pct,
            "market_cap": num(ov.get("market_cap")),
            "shares": num(ov.get("issue_share")),
            "foreign_pct": round(num(ov.get("foreigner_percentage")) * 100, 2) if num(ov.get("foreigner_percentage")) else None,
            "profile": str(ov.get("company_profile") or ""),
            "fundamentals": fund,
            "dividends": divs,
            "peers": peers,
            "cycle": compute_cycle(hist),
            "benchmark": benchmark,
            "news": news,
            "events": events,
            "technical": technical,
            "price_history": hist,
            "adj_history": adjusted_history(hist, divs),
        }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log("da ghi", OUT, f"({os.path.getsize(OUT)//1024} KB)")

    if do_full_marker:
        _write_marker(vn_today())

    if "--push" in sys.argv:
        git_push()


def git_push():
    import subprocess
    msg = "data: cap nhat HPA " + datetime.now(VN_TZ).strftime("%Y-%m-%d %H:%M")
    try:
        subprocess.run(["git", "-C", ROOT, "add", "docs/data/hpa.json"], check=True)
        # chi commit neu co thay doi
        r = subprocess.run(["git", "-C", ROOT, "diff", "--cached", "--quiet"])
        if r.returncode != 0:
            subprocess.run(["git", "-C", ROOT, "commit", "-m", msg], check=True)
            subprocess.run(["git", "-C", ROOT, "push"], check=True)
            log("da push len GitHub")
        else:
            log("khong co thay doi, bo qua push")
    except Exception as e:
        log("git push err:", e)


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""
update_sectors.py -- Chu ky nganh (sector rotation, kieu RRG) -> docs/data/sectors.json

Moi nganh ICB cap 2 lay toi da 6 ma thanh khoan nhat (HOSE/HNX), dung chi so
nganh equal-weight tu gia chuan hoa roi so voi VNINDEX:
    ratio = idx_nganh / VNINDEX
    rs    = 100 * ratio / SMA63(ratio)   -> >=100: manh hon trung binh 3 thang
    mom   = %change 21 phien cua ratio   -> da (momentum) cua suc manh tuong doi
4 pha chu ky:
    rs>=100 & mom>0  -> lead (Dan dat)     | rs>=100 & mom<=0 -> weak (Suy yeu)
    rs<100  & mom<=0 -> lag  (Tut hau)     | rs<100  & mom>0  -> improve (Hoi phuc)

Tu gate: chay kem hpa-update moi 15' nhung chi tinh 1 lan/ngay sau 15:40 VN
(hoac khi file qua cu / --force). Cac lan khac thoat ngay (exit 0).
"""
import os, sys, json, time, datetime as dt

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "docs", "data", "sectors.json")

TOP_N = 5            # so ma / nganh
MIN_VAL_BN = 1.0     # thanh khoan toi thieu (ty VND/phien) de xet
HIST_DAYS = 320      # ~15 thang lich su
CHUNK = 25
PACE = 0.3           # giay nghi giua 2 lan tai lich su (vnstock_data paid Golden = 500 req/phut)


def log(*a):
    print("[sectors]", *a, flush=True)


def vn_now():
    return dt.datetime.utcnow() + dt.timedelta(hours=7)


def should_run():
    if "--force" in sys.argv:
        return True
    now = vn_now()
    if not os.path.exists(OUT):
        return True
    try:
        old = json.load(open(OUT, encoding="utf-8"))
        cur, n_old = old.get("date"), len(old.get("sectors") or [])
    except Exception:
        return True
    today = now.date().isoformat()
    after_close = now.hour * 60 + now.minute >= 15 * 60 + 40
    if cur == today:
        return n_old < 12 and after_close              # ban hom nay bi thieu (rate limit) -> lam lai sau phien
    yesterday = (now.date() - dt.timedelta(days=1)).isoformat()
    if cur < yesterday:
        return True                                    # qua cu -> bo sung ngay
    if now.weekday() >= 5:
        return False                                   # cuoi tuan: giu ban cu
    return after_close                                 # cho het phien


def _num(x):
    try:
        f = float(x)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def fetch_universe():
    """-> (sym2ind: {sym: (icb_code, icb_name)} cap 2, hpa_ind: (code, name))."""
    try:
        from vnstock_data.api.listing import Listing
    except Exception:
        from vnstock.api.listing import Listing
    L = Listing(source="VCI")
    ind = L.symbols_by_industries()
    lv2 = ind[ind["icb_level"].astype(int) == 2]
    sym2ind, hpa_ind = {}, None
    for _, r in lv2.iterrows():
        s = str(r["symbol"]).upper()
        sym2ind[s] = (str(r["icb_code"]), str(r["icb_name"]))
        if s == "HPA":
            hpa_ind = (str(r["icb_code"]), str(r["icb_name"]))
    ex = L.symbols_by_exchange()
    ok = set()
    for _, r in ex.iterrows():
        if (str(r.get("type", "")).lower() == "stock"
                and str(r.get("exchange", "")).upper() in ("HSX", "HNX")
                and len(str(r.get("symbol", ""))) == 3):
            ok.add(str(r["symbol"]).upper())
    sym2ind = {s: v for s, v in sym2ind.items() if s in ok}
    log(f"{len(sym2ind)} ma HOSE/HNX co phan nganh; HPA thuoc: {hpa_ind}")
    return sym2ind, hpa_ind


def fetch_liquidity(syms):
    """-> {sym: gia_tri_khop_ty} tu price_board (phien gan nhat)."""
    try:
        from vnstock_data.api.trading import Trading
    except Exception:
        from vnstock.api.trading import Trading
    T = Trading(source="VCI")
    out = {}
    syms = sorted(syms)
    for i in range(0, len(syms), CHUNK):
        part = syms[i:i + CHUNK]
        try:
            pb = T.price_board(part)
            cols = list(pb.columns)
            for _, r in pb.iterrows():
                d = {("__".join(str(x) for x in c) if isinstance(c, tuple) else str(c)): r[c] for c in cols}
                s = str(d.get("listing__symbol", "")).upper()
                v = _num(d.get("match__accumulated_value"))   # don vi: TRIEU dong
                if s and v:
                    out[s] = v / 1e3                          # -> ty dong
        except Exception as e:
            log("price_board lo loi:", str(e)[:80])
        time.sleep(0.2)
    return out


def fetch_history(sym, start):
    try:
        from vnstock_data.api.quote import Quote
    except Exception:
        from vnstock.api.quote import Quote
    df = Quote(symbol=sym, source="VCI").history(start=start, end=vn_now().date().isoformat(), interval="1D")
    df = df.rename(columns=str.lower)
    import pandas as pd
    ser = pd.Series(df["close"].values, index=pd.to_datetime(df["time"]).dt.date)
    return ser[~ser.index.duplicated(keep="last")]


def main():
    if not should_run():
        log("bo qua (da co ban moi / chua het phien).")
        return
    import pandas as pd

    try:
        sym2ind, hpa_ind = fetch_universe()
        liq = fetch_liquidity(sym2ind.keys())
    except Exception as e:
        log("khong lay duoc universe (rate limit?) -> giu ban cu:", str(e)[:80])
        return

    # chon top thanh khoan moi nganh
    groups = {}
    for s, (code, name) in sym2ind.items():
        v = liq.get(s, 0)
        if v >= MIN_VAL_BN:
            groups.setdefault((code, name), []).append((v, s))
    picks = {}
    for k, lst in groups.items():
        lst.sort(reverse=True)
        if len(lst) >= 3:
            picks[k] = [s for _, s in lst[:TOP_N]]
    log(f"{len(picks)} nganh du dieu kien (>=3 ma thanh khoan)")

    start = (vn_now().date() - dt.timedelta(days=HIST_DAYS)).isoformat()
    try:
        vni = fetch_history("VNINDEX", start)
    except Exception as e:
        log("khong lay duoc VNINDEX (rate limit?) -> giu ban cu:", str(e)[:80])
        return
    log(f"VNINDEX: {len(vni)} phien")

    closes = {}
    for k, syms in picks.items():
        for s in syms:
            if s in closes:
                continue
            for attempt in range(2):
                try:
                    closes[s] = fetch_history(s, start)
                    break
                except Exception as e:
                    if attempt:
                        log(f"{s} loi: {str(e)[:60]}")
                    else:
                        time.sleep(6)          # dinh rate limit -> nghi dai roi thu lai
            time.sleep(PACE)
    log(f"da tai lich su {len(closes)} ma")

    sectors = []
    for (code, name), syms in picks.items():
        cols = [closes[s] for s in syms if s in closes and len(closes[s]) > 130]
        if len(cols) < 3:
            continue
        df = pd.DataFrame({s: closes[s] for s in syms if s in closes}).sort_index().ffill()
        df = df.dropna(how="any")
        if len(df) < 130:
            continue
        idx = (df / df.iloc[0]).mean(axis=1)                    # chi so EW chuan hoa
        bench = vni.reindex(idx.index).ffill()
        ratio = idx / (bench / bench.iloc[0])
        sma = ratio.rolling(63).mean()
        rs_ser = 100 * ratio / sma
        mom_ser = 100 * (ratio / ratio.shift(21) - 1)
        if pd.isna(rs_ser.iloc[-1]) or pd.isna(mom_ser.iloc[-1]):
            continue
        rs, mom = float(rs_ser.iloc[-1]), float(mom_ser.iloc[-1])
        phase = ("lead" if mom > 0 else "weak") if rs >= 100 else ("improve" if mom > 0 else "lag")
        ma50 = df.rolling(50).mean()
        breadth = int(round(100 * (df.iloc[-1] > ma50.iloc[-1]).mean()))
        trail = []
        for j in range(-36, 1, 5):                              # 8 diem, cach 5 phien (~8 tuan)
            i = len(rs_ser) - 1 + j
            if 0 <= i < len(rs_ser) and not pd.isna(rs_ser.iloc[i]) and not pd.isna(mom_ser.iloc[i]):
                trail.append([round(float(rs_ser.iloc[i]), 2), round(float(mom_ser.iloc[i]), 2)])
        sectors.append({
            "code": code, "name": name, "n": len(df.columns),
            "rs": round(rs, 2), "mom": round(mom, 2), "phase": phase,
            "breadth50": breadth, "top": syms[:4], "trail": trail,
            "is_hpa": bool(hpa_ind and code == hpa_ind[0]),
        })

    order = {"lead": 0, "improve": 1, "weak": 2, "lag": 3}
    sectors.sort(key=lambda s: (order[s["phase"]], -s["rs"]))
    out = {
        "date": vn_now().date().isoformat(),
        "updated_at": vn_now().strftime("%Y-%m-%dT%H:%M:%S+07:00"),
        "benchmark": "VNINDEX",
        "hpa_industry": hpa_ind[1] if hpa_ind else None,
        "sectors": sectors,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log(f"OK: {len(sectors)} nganh -> {OUT}")


if __name__ == "__main__":
    main()

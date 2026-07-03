# -*- coding: utf-8 -*-
"""
update_cycle.py -- Chu ky nganh chan nuoi (phan tich CO BAN) -> docs/data/agri_cycle.json

HPA kinh doanh loi: chan nuoi lon (7 trai, ~162k con/lua) + 2 nha may thuc an
chan nuoi (600k tan/nam) + bo Uc + trung ga. Chu ky nganh duoc do bang:
  - Gia lon: hop dong tuong lai Lean Hogs CME (HE=F) — proxy toan cau
  - Chi phi thuc an: ro 60% ngo (ZC=F) + 40% kho dau tuong (ZM=F)
  - TY SO LON/THUC AN = proxy bien loi nhuan chan nuoi — chi bao kinh dien cua
    chu ky tai dan: ty so cao -> lai tot -> tai dan manh -> 6-12 thang sau nguon
    cung tang -> gia lon giam -> ty so giam (va nguoc lai).
Overlay gia HPA (tuan, 3 nam) va quet DO TRE 0-26 tuan de tim tuong quan tot nhat
(ty so dan truoc gia co phieu bao nhieu tuan).

Luu y: gia lon My khong phan anh het gia lon VN (dich ASF, cung noi dia) — day la
proxy; chi phi thuc an (ngo/kho dau nhap khau) thi bam sat thuc te VN hon.
Tu gate: 1 lan/ngay. --force de ep chay lai.
"""
import os, sys, json, time, urllib.request, datetime as dt

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "docs", "data", "agri_cycle.json")
FEED_MIX = (("ZC=F", 0.6), ("ZM=F", 0.4))   # ngo 60% + kho dau tuong 40%
WEEKS = 156                                  # ~3 nam


def log(*a):
    print("[cycle]", *a, flush=True)


def vn_now():
    return dt.datetime.utcnow() + dt.timedelta(hours=7)


def should_run():
    if "--force" in sys.argv:
        return True
    if not os.path.exists(OUT):
        return True
    try:
        return json.load(open(OUT, encoding="utf-8")).get("date") != vn_now().date().isoformat()
    except Exception:
        return True


def yahoo_weekly(sym):
    """Gia dong cua theo TUAN tu Yahoo chart API -> {monday_iso: close}."""
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(sym)}"
           f"?range=3y&interval=1wk")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    d = json.load(urllib.request.urlopen(req, timeout=25))
    r = d["chart"]["result"][0]
    ts, cs = r["timestamp"], r["indicators"]["quote"][0]["close"]
    out = {}
    for t, c in zip(ts, cs):
        if c is None:
            continue
        day = dt.date.fromtimestamp(t)
        monday = day - dt.timedelta(days=day.weekday())
        out[monday.isoformat()] = float(c)
    return out


def hpa_weekly():
    """Gia HPA theo tuan (close cuoi tuan) tu vnstock, 3 nam."""
    from vnstock.api.quote import Quote
    start = (vn_now().date() - dt.timedelta(days=WEEKS * 7 + 30)).isoformat()
    df = Quote(symbol="HPA", source="VCI").history(start=start, end=vn_now().date().isoformat(), interval="1D")
    df = df.rename(columns=str.lower)
    out = {}
    for _, r in df.iterrows():
        day = r["time"].date() if hasattr(r["time"], "date") else dt.date.fromisoformat(str(r["time"])[:10])
        monday = day - dt.timedelta(days=day.weekday())
        out[monday.isoformat()] = float(r["close"]) * 1000.0   # nghin dong -> dong
    return out


def pearson(xs, ys):
    n = len(xs)
    if n < 30:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    sxx = sum((a - mx) ** 2 for a in xs)
    syy = sum((b - my) ** 2 for b in ys)
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / (sxx * syy) ** 0.5


def main():
    if not should_run():
        log("bo qua (hom nay da tinh).")
        return

    try:
        hog = yahoo_weekly("HE=F")
        feeds = [(yahoo_weekly(s), w) for s, w in FEED_MIX]
        time.sleep(0.3)
    except Exception as e:
        log("Yahoo loi -> giu ban cu:", str(e)[:80])
        return
    try:
        hpa = hpa_weekly()
    except Exception as e:
        log("vnstock HPA loi -> giu ban cu:", str(e)[:80])
        return

    # tuan chung cua hog + feed (HPA co the thieu vai tuan — cho phep None de ve dut quang)
    weeks = sorted(set(hog) & set.intersection(*[set(f) for f, _ in feeds]))[-WEEKS:]
    if len(weeks) < 60:
        log("thieu du lieu tuan:", len(weeks))
        return
    h0 = hog[weeks[0]]
    f0s = [f[weeks[0]] for f, _ in feeds]
    hog_n, feed_n, ratio_n = [], [], []
    for w in weeks:
        h = 100 * hog[w] / h0
        f = sum(wt * 100 * f[w] / f0 for (f, wt), f0 in zip(feeds, f0s))
        hog_n.append(round(h, 2))
        feed_n.append(round(f, 2))
        ratio_n.append(round(100 * h / f, 2))
    hpa_first = next((hpa[w] for w in weeks if w in hpa), None)
    hpa_n = [round(100 * hpa[w] / hpa_first, 2) if (w in hpa and hpa_first) else None for w in weeks]

    # quet do tre: ratio dan truoc gia HPA lag tuan (0..26)
    best_lag, best_r, r0 = 0, None, None
    pairs_all = [(i, v) for i, v in enumerate(hpa_n) if v is not None]
    for lag in range(0, 27):
        xs, ys = [], []
        for i, v in pairs_all:
            j = i - lag
            if j >= 0:
                xs.append(ratio_n[j]); ys.append(v)
        r = pearson(xs, ys)
        if lag == 0:
            r0 = r
        if r is not None and (best_r is None or abs(r) > abs(best_r)):
            best_lag, best_r = lag, r

    # trang thai hien tai cua ty so lon/thuc an
    cur = ratio_n[-1]
    pctile = round(100 * sum(1 for v in ratio_n if v <= cur) / len(ratio_n))
    chg13 = round(100 * (ratio_n[-1] / ratio_n[-14] - 1), 1) if len(ratio_n) > 14 else None

    out = {
        "date": vn_now().date().isoformat(),
        "updated_at": vn_now().strftime("%Y-%m-%dT%H:%M:%S+07:00"),
        "series": {"t": weeks, "hog": hog_n, "feed": feed_n, "ratio": ratio_n, "hpa": hpa_n},
        "stats": {"ratio_now": cur, "ratio_pctile_3y": pctile, "ratio_chg_13w": chg13,
                  "corr_lag0": round(r0, 2) if r0 is not None else None,
                  "best_lag_w": best_lag,
                  "best_r": round(best_r, 2) if best_r is not None else None},
        "biz": ("HPA: 7 trại lợn (~162k con/lứa) · 2 nhà máy TACN 600k tấn/năm · 3 trại bò Úc · "
                "2 trại gà (~330tr trứng/năm) → giá lợn và chi phí cám (ngô + khô đậu) là 2 biến số lõi."),
        "proxy_note": ("Giá lợn dùng hợp đồng Lean Hogs CME (proxy toàn cầu — giá lợn VN còn chịu "
                       "dịch bệnh/cung nội địa); chi phí thức ăn = 60% ngô + 40% khô đậu tương (nhập khẩu, bám sát VN)."),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    log(f"OK: {len(weeks)} tuan | ratio={cur} (pctile {pctile}%) | lag tot nhat={best_lag} tuan r={best_r}")


if __name__ == "__main__":
    main()

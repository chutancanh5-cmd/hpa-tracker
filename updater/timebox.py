# -*- coding: utf-8 -*-
"""
timebox.py -- Tran thoi gian CUNG cho script chay trong GitHub Actions.

Ly do ton tai: `timeout-minutes` cua mot buoc la dao cua runner. Khi no chem,
buoc co conclusion 'cancelled' chu KHONG phai 'failure' -> `|| true` trong
`run:` vo dung, ca job do, va moi thu buoc do da lam bi vut (xem memory
ci-timeout-swallows-work). Deadline "mem" (kiem tra giua hai vong lap) khong
cuu duoc truong hop MOT loi goi mang treo -- VCI tung treo 96s cho mot ma (xem
memory vci-chan-ip-cloud) -- vi khong ai chay den cho kiem tra.

Cach dung, ngay dau main():
    from timebox import arm
    arm(150, "sectors")      # phai < timeout-minutes cua buoc

arm() bat mot luong nen; den han no in log roi os._exit(code). Khong doi luong
dang treo (thread daemon khong giet duoc socket dang cho), khong nem exception
(exception se bi cac `except Exception` o tren nuot mat). Mac dinh code = 0:
het gio nghia la "lan nay khong kip, giu ban cu", khong phai loi.
"""
import os
import sys
import threading
import time

_armed = False


def arm(seconds, name="timebox", code=0):
    """Hen gio thoat cung sau `seconds`. Goi nhieu lan thi chi lan dau co tac dung."""
    global _armed
    if _armed:
        return
    _armed = True
    seconds = float(seconds)

    def _bang():
        time.sleep(seconds)
        try:
            print(f"[{name}] HET GIO CUNG sau {seconds:.0f}s -> thoat sach (code {code}), "
                  f"giu ban cu, thu lai lan chay sau.", flush=True)
            sys.stdout.flush()
            sys.stderr.flush()
        finally:
            os._exit(code)

    t = threading.Thread(target=_bang, name=name + "-timebox", daemon=True)
    t.start()
    return t


def from_env(var, default_s, name, margin=0.0, code=0):
    """arm() voi so giay lay tu bien moi truong `var` (de chinh trong workflow)."""
    try:
        s = float(os.environ.get(var, default_s))
    except (TypeError, ValueError):
        s = float(default_s)
    return arm(s + margin, name, code)

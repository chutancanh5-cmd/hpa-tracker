@echo off
REM ==== Cap nhat TU DONG theo GIO VIET NAM (doc lap mui gio may) ====
REM Task Scheduler chay file nay moi 15 phut CA NGAY. Script tu quyet dinh:
REM   - FULL update 1 lan/ngay (lan dau sau 8h sang gio VN)
REM   - LIGHT update khi dang trong gio giao dich HOSE (9:00-11:30, 13:00-15:00 gio VN)
REM   - Bo qua (thoat nhanh) ngoai gio giao dich.
chcp 65001 >nul
cd /d C:\Users\chuta\hpa-tracker
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set PATH=C:\Program Files\Git\cmd;%PATH%
"C:\Users\chuta\AppData\Local\Programs\Python\Python312\python.exe" updater\update_hpa.py --auto --push >> updater\update.log 2>&1

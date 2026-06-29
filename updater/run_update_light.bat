@echo off
REM ==== Cap nhat NHE: chi GIA + TIN HIEU KY THUAT (nhanh) + push ====
REM Dung cho Task Scheduler chay thuong xuyen trong gio giao dich (vd moi 15 phut).
chcp 65001 >nul
cd /d C:\Users\chuta\hpa-tracker
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set PATH=C:\Program Files\Git\cmd;%PATH%
"C:\Users\chuta\AppData\Local\Programs\Python\Python312\python.exe" updater\update_hpa.py --light --push >> updater\update.log 2>&1

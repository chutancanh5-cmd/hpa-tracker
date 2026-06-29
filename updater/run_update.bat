@echo off
REM ==== Cap nhat DAY DU du lieu HPA (peers, benchmark, news, fundamentals...) + push ====
REM Dung cho Task Scheduler 1-2 lan/ngay (vd 8:30 sang truoc phien).
chcp 65001 >nul
cd /d C:\Users\chuta\hpa-tracker
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set PATH=C:\Program Files\Git\cmd;%PATH%
"C:\Users\chuta\AppData\Local\Programs\Python\Python312\python.exe" updater\update_hpa.py --push >> updater\update.log 2>&1

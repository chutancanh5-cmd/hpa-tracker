@echo off
REM ==== Cap nhat du lieu HPA va day len GitHub Pages ====
REM Dung cho Windows Task Scheduler. Chay vai lan/ngay trong gio giao dich.
chcp 65001 >nul
cd /d C:\Users\chuta\hpa-tracker
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
python updater\update_hpa.py --push >> updater\update.log 2>&1

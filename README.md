# HPA · Sổ đầu tư

App cá nhân (PWA) theo dõi đầu tư cổ phiếu **HPA — CTCP Phát triển Nông nghiệp Hòa Phát**.
Cài lên màn hình chính iPhone như app thật, chạy offline, lưu sổ giao dịch ngay trên máy.

## Tính năng
- **Tổng quan**: giá hiện tại, vốn đang đầu tư, giá vốn TB, lãi/lỗ tạm tính, lãi/lỗ đã chốt, cổ tức đã nhận, tổng lời/lỗ. **Biểu đồ lãi/lỗ tích lũy theo thời gian**.
- **Giao dịch**: nhập lệnh MUA/BÁN đã khớp (ngày, số lượng, giá, phí/thuế tự tính). Sửa/xóa, lưu lịch sử theo ngày. Tự tính theo **bình quân giá vốn**, có tùy chọn **trừ cổ tức vào giá vốn** (giống công ty CK). **Máy tính hòa vốn + mua bình quân (DCA)**.
- **Cổ tức**: tự cộng cổ tức tiền mặt cho số CP nắm giữ trước ngày GDKHQ; lịch trả 2022–2025; sau thuế 5%. **Nhắc sự kiện sắp tới (đếm ngược) + tin tức gần đây**.
- **Cơ bản**: P/E, P/B, ROE, ROA, EPS, biên LN... + **so sánh cùng ngành** (Nông–Lâm–Ngư).
- **Biểu đồ**: **HPA vs VN-Index vs Ngành** (rebase 100); giá đóng cửa (có nút **điều chỉnh theo cổ tức**), chu kỳ/biến động, và vị thế của bạn (đường giá vốn + điểm mua/bán).

## Khóa API vnstock (tùy chọn, để chạy nhanh/ổn định hơn)
Updater chạy được với key free (60 req/phút) đã đăng ký sẵn. Để dùng **key trả phí** của bạn:
- **Cách 1 (khuyên dùng):** dán key vào file `updater/vnstock_key.txt` (file này KHÔNG commit lên git). Updater tự đọc.
- **Cách 2:** đặt biến môi trường `VNSTOCK_API_KEY=<key>` trước khi chạy.

Updater in ra tier đang dùng mỗi lần chạy (`vnstock tier: ...`) để bạn kiểm tra.

## Cấu trúc
```
hpa-tracker/
├── docs/                     ← GitHub Pages phục vụ thư mục này
│   ├── index.html  app.js  styles.css
│   ├── manifest.webmanifest  sw.js  icons/
│   └── data/hpa.json         ← dữ liệu (PC tự cập nhật)
└── updater/
    ├── update_hpa.py         ← vnstock → hpa.json → git push
    ├── run_update.bat        ← cho Task Scheduler
    └── requirements.txt
```

## Chạy thử trên máy
```
cd hpa-tracker/docs
python -m http.server 8754
# mở http://127.0.0.1:8754
```
Cập nhật dữ liệu thủ công: `python updater/update_hpa.py`

## Deploy lên GitHub Pages (để cài lên iPhone)
1. Tạo repo trên GitHub (vd `hpa-tracker`), **Public**.
2. Trong thư mục dự án:
   ```
   git init
   git add .
   git commit -m "HPA tracker"
   git branch -M main
   git remote add origin https://github.com/<user>/hpa-tracker.git
   git push -u origin main
   ```
3. GitHub → repo → **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main`, thư mục `/docs` → Save.
4. Sau ~1 phút, app ở: `https://<user>.github.io/hpa-tracker/`

## Cài lên iPhone
1. Mở link GitHub Pages bằng **Safari**.
2. Bấm nút **Chia sẻ** → **Thêm vào MH chính** → Thêm.
3. App hiện icon HPA trên màn hình chính, mở toàn màn hình. Sổ giao dịch lưu trên chính iPhone.

## Tự động cập nhật giá (Task Scheduler)
1. Mở **Task Scheduler** → Create Basic Task.
2. Trigger: hằng ngày, lặp lại mỗi 30–60 phút trong giờ giao dịch (9:00–15:00, T2–T6).
3. Action: Start a program → `C:\Users\chuta\hpa-tracker\updater\run_update.bat`
4. `run_update.bat` chạy vnstock, ghi `hpa.json` rồi `git push` → GitHub Pages tự cập nhật, app trên iPhone nhận dữ liệu mới khi mở.

> Cần cấu hình git (`git config --global user.name/email`) và đăng nhập GitHub (Git Credential Manager) để `--push` hoạt động không cần nhập mật khẩu.

## Lưu ý
- HPA niêm yết HOSE **06/02/2026** → lịch sử giá còn ngắn (~93 phiên), phần "chu kỳ" chỉ mang tính biến động ngắn hạn.
- Dữ liệu lấy từ **vnstock** (nguồn VCI), gần real-time trong giờ giao dịch, không phải dữ liệu khớp lệnh tức thời.
- Phương pháp tính lãi/lỗ: **bình quân giá vốn**. Phí/thuế mặc định VN (mua ~0.15%, bán ~0.15%+0.1%, cổ tức 5%) — chỉnh trong tab Giao dịch → Cài đặt.
- **Sao lưu**: tab Giao dịch → Sao lưu/Khôi phục → Xuất file `.json` định kỳ (vì sổ lưu trên trình duyệt điện thoại).

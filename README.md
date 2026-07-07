# 🐥 PiPi English — Hướng dẫn chạy & đưa lên Render

Dự án gồm:
- `public/index.html` — toàn bộ game (105 unit, 630 từ, 5 game + Typing Practice)
- `server.js` — backend: đăng ký/đăng nhập, Google Sign-In, thanh toán PayOS, lưu tiến độ
- `render.yaml` — cấu hình deploy tự động cho Render

Chưa cấu hình gì thì hệ thống vẫn chạy được ngay:
- Google Sign-In: tự ẩn nút Google (vẫn đăng ký bằng email được)
- Thanh toán: chạy **chế độ DEMO** — bấm "Pay now" là kích hoạt PRO luôn (để bạn test)

---

## 1. Chạy thử trên máy tính

```bash
cd pipi-app
npm install
npm start
```
Mở http://localhost:3000 → đăng ký tài khoản → bấm Upgrade → Pay now (demo) → tài khoản thành PRO, mở khóa toàn bộ.

---

## 2. Đưa code lên GitHub

1. Tạo repository mới trên https://github.com (ví dụ `pipi-english`), để **Private**.
2. Trong thư mục dự án chạy:
```bash
git init
git add .
git commit -m "PiPi English v1"
git branch -M main
git remote add origin https://github.com/TEN_CUA_BAN/pipi-english.git
git push -u origin main
```

---

## 3. Deploy lên Render (miễn phí)

1. Vào https://render.com → đăng ký/đăng nhập (dùng luôn tài khoản GitHub cho nhanh).
2. Bấm **New → Blueprint** → chọn repo `pipi-english` → Render tự đọc `render.yaml`.
   - (Hoặc **New → Web Service** → chọn repo → Build: `npm install`, Start: `npm start`)
3. Bấm **Apply/Deploy** → chờ 2–5 phút → bạn có link dạng `https://pipi-english.onrender.com`.
4. Vào tab **Environment** của service, điền:
   - `BASE_URL` = `https://pipi-english.onrender.com` (đúng link của bạn)
   - Các key khác điền ở bước 4 & 5 bên dưới.

⚠️ **Lưu ý gói Free của Render:**
- App "ngủ" sau 15 phút không ai dùng, lần mở đầu chờ ~30 giây.
- **Ổ đĩa không lưu vĩnh viễn** → file SQLite (tài khoản, tiến độ) sẽ MẤT mỗi lần deploy lại.
  Khi bắt đầu có khách thật, chọn 1 trong 2:
  - Gắn **Render Disk** (~$0.25/GB/tháng): tạo Disk, mount vào `/data`, thêm biến `DB_PATH=/data/pipi.db`
  - Hoặc chuyển sang Render PostgreSQL (nâng cấp code sau).

---

## 4. Bật đăng nhập Google

1. Vào https://console.cloud.google.com → tạo Project mới (ví dụ "PiPi English").
2. **APIs & Services → OAuth consent screen** → chọn External → điền tên app, email → Save.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://pipi-english.onrender.com` (và `http://localhost:3000` để test máy)
4. Copy **Client ID** (dạng `xxxx.apps.googleusercontent.com`).
5. Trên Render → Environment → điền `GOOGLE_CLIENT_ID` = Client ID đó → Save (Render tự deploy lại).
6. Xong! Nút "Sign in with Google" sẽ tự hiện trong modal đăng nhập.

---

## 5. Bật thanh toán thật với PayOS

PayOS (https://payos.vn) là cổng thanh toán QR ngân hàng phổ biến cho cá nhân/doanh nghiệp VN, phí thấp, tích hợp sẵn trong code.

1. Đăng ký tài khoản PayOS → tạo **Kênh thanh toán** → lấy 3 key:
   `Client ID`, `API Key`, `Checksum Key`.
2. Trên Render → Environment → điền:
   - `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`
   - `PRO_PRICE` = giá bán (VND, mặc định 299000)
3. Trong trang quản trị PayOS → cấu hình **Webhook URL**:
   `https://pipi-english.onrender.com/api/pay/webhook`
4. Từ giờ bấm "Pay now" → chuyển sang trang QR PayOS → khách quét chuyển khoản → PayOS gọi webhook → tài khoản tự lên PRO → quay về web thấy pháo hoa 🎉.

> Chưa điền key PayOS = chế độ demo (kích hoạt PRO không thu tiền) — nhớ điền key trước khi bán thật!

---

## 6. Kiến trúc & mở rộng sau này

| Thành phần | Hiện tại | Khi lớn hơn |
|---|---|---|
| CSDL | SQLite (1 file) | PostgreSQL trên Render |
| Ảnh minh họa | Emoji | Thay `img` bằng link ảnh — code đã hỗ trợ sẵn |
| Âm thanh | Giọng máy trình duyệt | File thu âm thật |
| Tên miền | *.onrender.com | Gắn domain riêng (Settings → Custom Domain, miễn phí SSL) |

API có sẵn: `/api/register` `/api/login` `/api/google` `/api/me` `/api/logout` `/api/progress` `/api/pay/create` `/api/pay/webhook`

Chúc bạn ra mắt thành công! 🐥🚀

---

## 7. (MỚI) Trang quản trị Admin

Địa chỉ: `https://ten-app.onrender.com/admin`

**Kích hoạt:** trên Render → Environment → đặt `ADMIN_EMAILS` = email của bạn (nhiều admin cách nhau dấu phẩy). Sau đó đăng ký tài khoản bằng đúng email đó trên web, rồi vào /admin đăng nhập.

Chức năng:
- **👤 Khách hàng**: tìm kiếm, xem trạng thái, bấm **Cấp PRO / Hủy PRO** cho bất kỳ ai
- **💰 Doanh thu**: tổng hôm nay / tháng / toàn bộ, danh sách từng đơn, nút **📥 Xuất Excel** (.xlsx)
- **📚 Nội dung**: thêm/sửa/xóa **Lớp → Unit → Từ** với đầy đủ trường: tên, icon/emoji, mô tả, PRO, từ EN, nghĩa VI, phiên âm IPA, **hình ảnh** (emoji hoặc link ảnh), **âm thanh** (link mp3 — bỏ trống thì dùng giọng đọc en-US của máy). Sửa xong, mọi thiết bị tải lại trang là thấy nội dung mới (đồng bộ từ database).
- **⚙️ Cài đặt**: đổi **giá PRO** — áp dụng ngay cho modal Upgrade và các đơn tiếp theo

## 8. (MỚI) Thanh toán tự động SePay — QR VietQR tự sinh

Luồng: khách bấm Pay now → web hiện **mã QR ngân hàng** (số tiền + nội dung `PIPIxxxxx` điền sẵn) → khách quét bằng app ngân hàng → SePay phát hiện tiền vào → gọi webhook → **PRO kích hoạt tự động trong ~3 giây**, màn hình khách tự hiện "✅ Payment received!" và pháo hoa.

Cài đặt:
1. Đăng ký https://my.sepay.vn → liên kết tài khoản ngân hàng nhận tiền của bạn.
2. Trên Render → Environment điền:
   - `SEPAY_BANK` = tên ngân hàng (vd `MBBank`, `VCB`, `ACB`, `TPBank`…)
   - `SEPAY_ACC` = số tài khoản nhận tiền
3. Trong SePay → **Webhooks → Thêm webhook**:
   - URL: `https://ten-app.onrender.com/api/pay/webhook/sepay`
   - Kiểu xác thực: **API Key** → tạo key → copy key đó điền vào biến `SEPAY_API_KEY` trên Render.
4. Xong. Chưa điền đủ 3 biến SePay = hệ thống tự chạy **chế độ demo** (bấm Pay là lên PRO, không thu tiền) để bạn test.

## 9. (MỚI) Ngôn ngữ & âm thanh khóa English

- Toàn bộ giao diện học tập là English; giọng đọc **luôn ép chọn giọng en-US** của thiết bị (không phụ thuộc ngôn ngữ hệ điều hành/trình duyệt của khách).
- Muốn đồng nhất 100% giọng đọc trên MỌI thiết bị: vào Admin → Nội dung → điền link **file mp3** cho từng từ (thu âm hoặc tạo bằng Google TTS) — có file thì mọi máy phát cùng một âm thanh.
- Hoàn thành bài nào cũng có tiếng reo **"Yeeeee!"** + nhạc chiến thắng + vỗ tay.

## 10. (MỚI) Một tài khoản — một thiết bị

- Mỗi lần đăng nhập, hệ thống cấp một **mã phiên duy nhất**. Đăng nhập ở máy thứ 2 → mã phiên mới thay mã cũ → **máy cũ tự động bị thoát** (phát hiện trong tối đa 60 giây hoặc ngay ở thao tác kế tiếp) kèm thông báo "Your account was signed in on another device".
- Máy mới thấy thông báo "✓ Signed out from your other device" xác nhận đã thoát máy cũ.
- Chặn triệt để tình trạng 1 tài khoản PRO chia sẻ cho nhiều nhà dùng chung.

## 11. (MỚI) Bảo đảm tự động lên PRO sau thanh toán

- Webhook SePay nhận diện nội dung chuyển khoản linh hoạt hơn (chấp nhận "PIPI 123..." có khoảng trắng, thiếu trường transferType).
- Khách chuyển khoản xong quay lại tab web (kể cả đã lỡ tắt bảng QR) → hệ thống tự kiểm tra và **kích hoạt PRO ngay + pháo hoa chúc mừng**, không cần tải lại trang.

## 12. (MỚI) Gói Basic — khách tự chọn 1 Grade bất kỳ

- Sau khi thanh toán Basic (hoặc được admin cấp Basic), khách được mở bảng **"Choose your grade!"** để chọn 1 trong các lớp — lớp nào cũng được, không bắt buộc Grade 1.
- Lựa chọn là **một lần duy nhất** (có cảnh báo xác nhận trước khi chốt).
- Admin xem được khách Basic đã chọn lớp nào ngay trong tab Khách hàng.
- Muốn cho khách chọn lại: vào Admin → chọn lại gói **Basic** cho tài khoản đó (mọi lần đổi gói đều reset lựa chọn lớp).

/* ============================================================
   PiPi English — Backend (Express + SQLite)
   Đăng ký / Đăng nhập / Google Sign-In / Thanh toán PayOS / Lưu tiến độ
   ============================================================ */
const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { OAuth2Client } = require("google-auth-library");

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-doi-khi-len-production";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const PAYOS_CLIENT_ID = process.env.PAYOS_CLIENT_ID || "";
const PAYOS_API_KEY = process.env.PAYOS_API_KEY || "";
const PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY || "";
const PRO_PRICE = parseInt(process.env.PRO_PRICE || "299000", 10); // VND / năm
const BASE_URL = process.env.BASE_URL || "http://localhost:" + PORT;

/* PayOS: chỉ bật khi có đủ 3 key — thiếu key sẽ chạy CHẾ ĐỘ DEMO
   (bấm thanh toán là kích hoạt PRO luôn, để bạn test luồng trước khi đăng ký PayOS) */
let payos = null;
if (PAYOS_CLIENT_ID && PAYOS_API_KEY && PAYOS_CHECKSUM_KEY) {
  const PayOS = require("@payos/node");
  payos = new PayOS(PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY);
}

/* ---------- Cơ sở dữ liệu ---------- */
const db = new Database(process.env.DB_PATH || path.join(__dirname, "pipi.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT,
  name TEXT,
  google_id TEXT,
  pro INTEGER DEFAULT 0,
  pro_until TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS progress(
  user_id INTEGER NOT NULL,
  k TEXT NOT NULL,
  stars INTEGER NOT NULL,
  PRIMARY KEY(user_id, k)
);
CREATE TABLE IF NOT EXISTS payments(
  order_code INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Helpers ---------- */
const safeUser = (u) => ({ email: u.email, name: u.name || "", pro: !!u.pro });
function setToken(res, u) {
  const token = jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: "30d" });
  res.cookie("pipi_token", token, {
    httpOnly: true, sameSite: "lax", secure: IS_PROD,
    maxAge: 30 * 24 * 3600 * 1000,
  });
}
function auth(req, res, next) {
  try {
    const { uid } = jwt.verify(req.cookies.pipi_token, JWT_SECRET);
    req.user = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
    if (!req.user) throw new Error();
    next();
  } catch (e) { res.status(401).json({ error: "Please sign in" }); }
}

/* ---------- Cấu hình cho frontend ---------- */
app.get("/api/config", (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, demoPay: !payos, price: PRO_PRICE });
});

/* ---------- Đăng ký / Đăng nhập email ---------- */
app.post("/api/register", (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: "Invalid email" });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password: at least 6 characters" });
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase()))
    return res.status(400).json({ error: "Email already registered" });
  const info = db.prepare("INSERT INTO users(email, pass_hash, name) VALUES(?,?,?)")
    .run(email.toLowerCase(), bcrypt.hashSync(password, 10), (name || "").slice(0, 50));
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
  setToken(res, u);
  res.json(safeUser(u));
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((email || "").toLowerCase());
  if (!u || !u.pass_hash || !bcrypt.compareSync(password || "", u.pass_hash))
    return res.status(400).json({ error: "Wrong email or password" });
  setToken(res, u);
  res.json(safeUser(u));
});

/* ---------- Đăng nhập Google ---------- */
const gClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
app.post("/api/google", async (req, res) => {
  if (!gClient) return res.status(400).json({ error: "Google sign-in not configured" });
  try {
    const ticket = await gClient.verifyIdToken({ idToken: req.body.credential, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    let u = db.prepare("SELECT * FROM users WHERE google_id=? OR email=?").get(p.sub, p.email.toLowerCase());
    if (!u) {
      const info = db.prepare("INSERT INTO users(email, name, google_id) VALUES(?,?,?)")
        .run(p.email.toLowerCase(), p.name || "", p.sub);
      u = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
    } else if (!u.google_id) {
      db.prepare("UPDATE users SET google_id=? WHERE id=?").run(p.sub, u.id);
    }
    setToken(res, u);
    res.json(safeUser(u));
  } catch (e) { res.status(400).json({ error: "Google sign-in failed" }); }
});

app.get("/api/me", auth, (req, res) => res.json(safeUser(req.user)));
app.post("/api/logout", (req, res) => { res.clearCookie("pipi_token"); res.json({ ok: true }); });

/* ---------- Tiến độ học ---------- */
app.get("/api/progress", auth, (req, res) => {
  res.json({ items: db.prepare("SELECT k, stars FROM progress WHERE user_id=?").all(req.user.id) });
});
app.post("/api/progress", auth, (req, res) => {
  const { k, stars } = req.body || {};
  if (typeof k !== "string" || k.length > 40 || ![1,2,3].includes(stars))
    return res.status(400).json({ error: "Bad data" });
  db.prepare(`INSERT INTO progress(user_id,k,stars) VALUES(?,?,?)
    ON CONFLICT(user_id,k) DO UPDATE SET stars=MAX(stars,excluded.stars)`).run(req.user.id, k, stars);
  res.json({ ok: true });
});

/* ---------- Thanh toán ---------- */
app.post("/api/pay/create", auth, async (req, res) => {
  if (req.user.pro) return res.json({ already: true });
  if (!payos) {
    // CHẾ ĐỘ DEMO: chưa cấu hình PayOS → kích hoạt PRO luôn để test luồng
    db.prepare("UPDATE users SET pro=1 WHERE id=?").run(req.user.id);
    return res.json({ demo: true });
  }
  try {
    const orderCode = Number(String(Date.now()).slice(-9));
    const link = await payos.createPaymentLink({
      orderCode,
      amount: PRO_PRICE,
      description: "PiPi English PRO 1 nam",
      returnUrl: BASE_URL + "/?paid=1",
      cancelUrl: BASE_URL + "/",
    });
    db.prepare("INSERT INTO payments(order_code, user_id, amount) VALUES(?,?,?)")
      .run(orderCode, req.user.id, PRO_PRICE);
    res.json({ checkoutUrl: link.checkoutUrl });
  } catch (e) { res.status(500).json({ error: "Cannot create payment" }); }
});

/* Webhook PayOS gọi khi khách chuyển khoản xong */
app.post("/api/pay/webhook", (req, res) => {
  if (!payos) return res.json({ ok: true });
  try {
    const data = payos.verifyPaymentWebhookData(req.body);
    if (data && (data.code === "00" || data.desc === "success")) {
      const pay = db.prepare("SELECT * FROM payments WHERE order_code=?").get(data.orderCode);
      if (pay && pay.status !== "paid") {
        db.prepare("UPDATE payments SET status='paid' WHERE order_code=?").run(data.orderCode);
        db.prepare("UPDATE users SET pro=1, pro_until=date('now','+1 year') WHERE id=?").run(pay.user_id);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: "Invalid webhook" }); }
});

app.listen(PORT, () => {
  console.log("🐥 PiPi English chạy tại " + BASE_URL);
  console.log("   Google Sign-In: " + (GOOGLE_CLIENT_ID ? "BẬT" : "TẮT (chưa có GOOGLE_CLIENT_ID)"));
  console.log("   Thanh toán:     " + (payos ? "PayOS THẬT" : "CHẾ ĐỘ DEMO (chưa có key PayOS)"));
});

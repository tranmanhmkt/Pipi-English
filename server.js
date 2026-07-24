/* ============================================================
   PiPi English — Backend v3
   Lưu trữ: Supabase Postgres (DATABASE_URL) hoặc SQLite (dự phòng local)
   Auth + 1 thiết bị · Gói Basic/Premium/Family · SePay QR · Admin · Excel
   ============================================================ */
const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-doi-khi-len-production";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:" + PORT;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const SEPAY_BANK = process.env.SEPAY_BANK || "";
const SEPAY_ACC = process.env.SEPAY_ACC || "";
const SEPAY_API_KEY = process.env.SEPAY_API_KEY || "";
const sepayOn = !!(SEPAY_BANK && SEPAY_ACC && SEPAY_API_KEY);

/* ================= LỚP TRUY CẬP DỮ LIỆU =================
   Có DATABASE_URL (Supabase) → Postgres, dữ liệu lưu vĩnh viễn trên cloud.
   Không có → SQLite file (chạy thử trên máy).                            */
const usePg = !!process.env.DATABASE_URL;
let q; // q(sql, params) -> Promise<rows>  (dấu ? tự đổi thành $1,$2… cho Postgres)

if (usePg) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,        // tự đóng kết nối rảnh sau 30s (trước khi Supabase cắt)
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  });
  /* Kết nối rảnh bị Supabase cắt sẽ bắn lỗi — không bắt là SẬP cả app → 502 */
  pool.on("error", err => console.error("PG idle error (đã bắt, app vẫn chạy):", err.message));
  q = async (sql, params = []) => {
    let i = 0;
    const text = sql.replace(/\?/g, () => "$" + (++i));
    try {
      const r = await pool.query(text, params);
      return r.rows;
    } catch (err) {
      // Kết nối cũ vừa chết → thử lại 1 lần với kết nối mới
      if (/terminat|ECONNRESET|Connection ended|timeout exceeded/i.test(err.message || "")) {
        const r = await pool.query(text, params);
        return r.rows;
      }
      throw err;
    }
  };
} else {
  const Database = require("better-sqlite3");
  const db = new Database(process.env.DB_PATH || path.join(__dirname, "pipi.db"));
  db.pragma("journal_mode = WAL");
  q = async (sql, params = []) => {
    const st = db.prepare(sql);
    return st.reader ? st.all(...params) : (st.run(...params), []);
  };
}
const one = async (sql, params) => (await q(sql, params))[0];

/* Các đoạn SQL khác nhau giữa 2 hệ */
const D = usePg ? {
  id: "SERIAL PRIMARY KEY",
  now: "now()",
  created: "to_char(created_at,'YYYY-MM-DD HH24:MI')",
  today: "created_at::date = CURRENT_DATE",
  month: "to_char(created_at,'YYYY-MM') = to_char(now(),'YYYY-MM')",
  plus1y: "CURRENT_DATE + interval '1 year'",
  maxStars: "GREATEST(progress.stars, excluded.stars)",
} : {
  id: "INTEGER PRIMARY KEY AUTOINCREMENT",
  now: "datetime('now','localtime')",
  created: "created_at",
  today: "date(created_at) = date('now','localtime')",
  month: "strftime('%Y-%m',created_at) = strftime('%Y-%m','now','localtime')",
  plus1y: "date('now','+1 year')",
  maxStars: "MAX(progress.stars, excluded.stars)",
};

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS users(
    id ${D.id}, email TEXT UNIQUE NOT NULL, pass_hash TEXT, name TEXT, google_id TEXT,
    pro INTEGER DEFAULT 0, pro_until TEXT, plan TEXT DEFAULT 'free',
    sid TEXT, basic_grade INTEGER, created_at TIMESTAMP DEFAULT ${usePg ? "now()" : "(datetime('now','localtime'))"})`);
  await q(`CREATE TABLE IF NOT EXISTS progress(user_id INTEGER NOT NULL, k TEXT NOT NULL, stars INTEGER NOT NULL, PRIMARY KEY(user_id,k))`);
  await q(`CREATE TABLE IF NOT EXISTS payments(
    order_code BIGINT PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER,
    status TEXT DEFAULT 'pending', channel TEXT DEFAULT 'sepay', plan TEXT DEFAULT 'premium',
    created_at TIMESTAMP DEFAULT ${usePg ? "now()" : "(datetime('now','localtime'))"})`);
  await q(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS grades(id ${D.id}, name TEXT, icon TEXT, sort INTEGER DEFAULT 0)`);
  await q(`CREATE TABLE IF NOT EXISTS units(id ${D.id}, grade_id INTEGER, name TEXT, emoji TEXT,
    description TEXT DEFAULT '', pro INTEGER DEFAULT 0, sort INTEGER DEFAULT 0)`);
  await q(`CREATE TABLE IF NOT EXISTS words(id ${D.id}, unit_id INTEGER,
    en TEXT, vi TEXT DEFAULT '', ipa TEXT DEFAULT '', img TEXT DEFAULT '', audio TEXT DEFAULT '', sort INTEGER DEFAULT 0)`);
  await q(`CREATE TABLE IF NOT EXISTS images(id ${D.id}, mime TEXT, data TEXT)`);

  /* Nâng cấp CSDL SQLite cũ (Postgres tạo mới đã đủ cột) */
  if (!usePg) {
    for (const alt of [
      "ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'",
      "ALTER TABLE users ADD COLUMN sid TEXT",
      "ALTER TABLE users ADD COLUMN basic_grade INTEGER",
      "ALTER TABLE payments ADD COLUMN plan TEXT DEFAULT 'premium'",
    ]) { try { await q(alt); } catch (e) {} }
    await q("UPDATE users SET plan='premium' WHERE pro=1 AND (plan IS NULL OR plan='free')");
  }

  /* Nạp nội dung mẫu lần đầu */
  const gc = await one("SELECT COUNT(*) AS c FROM grades");
  if (Number(gc.c) === 0) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-curriculum.json"), "utf8"));
    for (const g of seed.grades) {
      const gr = await one("INSERT INTO grades(name,icon,sort) VALUES(?,?,?) RETURNING id", [g.name, g.icon, g.sort]);
      for (const u of g.units) {
        const un = await one("INSERT INTO units(grade_id,name,emoji,description,pro,sort) VALUES(?,?,?,?,?,?) RETURNING id",
          [gr.id, u.name, u.emoji, u.description || "", u.pro ? 1 : 0, u.sort]);
        for (const w of u.words) {
          await q("INSERT INTO words(unit_id,en,vi,ipa,img,audio,sort) VALUES(?,?,?,?,?,?,?)",
            [un.id, w.en, w.vi, w.ipa, w.img, w.audio || "", w.sort]);
        }
      }
    }
    console.log("🌱 Đã nạp nội dung mẫu vào " + (usePg ? "Supabase" : "SQLite"));
  }

  if (!(await getSetting("mig_free_only_first"))) {
    const first = await one(`SELECT u.id FROM units u JOIN grades g ON g.id=u.grade_id
      ORDER BY g.sort,g.id,u.sort,u.id LIMIT 1`);
    if (first) {
      await q("UPDATE units SET pro=1 WHERE id<>?", [first.id]);
      await q("UPDATE units SET pro=0 WHERE id=?", [first.id]);
    }
    await setSetting("mig_free_only_first", "1");
  }

  const PRICE_DEFAULTS = {
    price_basic: "149000", list_basic: "499000",
    price_premium: "299000", list_premium: "799000",
    price_family: "499000", list_family: "1999000",
  };
  for (const k in PRICE_DEFAULTS) if (!(await getSetting(k))) await setSetting(k, PRICE_DEFAULTS[k]);
}

async function getSetting(k) { const r = await one("SELECT value FROM settings WHERE key=?", [k]); return r ? r.value : null; }
async function setSetting(k, v) {
  await q("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, String(v)]);
}
const PLANS = ["basic", "premium", "family"];
async function planPrice(p) { return parseInt(await getSetting("price_" + p), 10) || 0; }
async function prices() {
  return {
    basic: { list: +(await getSetting("list_basic")), sale: +(await getSetting("price_basic")) },
    premium: { list: +(await getSetting("list_premium")), sale: +(await getSetting("price_premium")) },
    family: { list: +(await getSetting("list_family")), sale: +(await getSetting("price_family")) },
  };
}

/* ================= APP ================= */
const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

const ah = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "Server error" });
});

const safeUser = u => {
  const plan = u.plan && u.plan !== "free" ? u.plan : (u.pro ? "premium" : "free");
  return {
    email: u.email, name: u.name || "", plan, pro: plan !== "free",
    basicGrade: (u.basic_grade === null || u.basic_grade === undefined) ? null : Number(u.basic_grade),
    admin: ADMIN_EMAILS.includes(u.email),
  };
};
async function setToken(res, u) {
  const sid = crypto.randomBytes(16).toString("hex");
  await q("UPDATE users SET sid=? WHERE id=?", [sid, u.id]);
  res.cookie("pipi_token", jwt.sign({ uid: u.id, sid }, JWT_SECRET, { expiresIn: "30d" }),
    { httpOnly: true, sameSite: "lax", secure: IS_PROD, maxAge: 30 * 24 * 3600 * 1000 });
}
function auth(req, res, next) {
  (async () => {
    try {
      const payload = jwt.verify(req.cookies.pipi_token, JWT_SECRET);
      req.user = await one("SELECT * FROM users WHERE id=?", [payload.uid]);
      if (!req.user) throw 0;
      if (req.user.sid && payload.sid !== req.user.sid)
        return res.status(401).json({ error: "Signed in on another device", code: "SESSION_REPLACED" });
      next();
    } catch (e) { res.status(401).json({ error: "Please sign in" }); }
  })();
}
function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (!ADMIN_EMAILS.includes(req.user.email)) return res.status(403).json({ error: "Admin only" });
    next();
  });
}

/* Health check: UptimeRobot trỏ vào đây (chạm cả DB để giữ kết nối ấm) */
app.get("/health", ah(async (req, res) => {
  await q("SELECT 1");
  res.json({ ok: true, db: usePg ? "supabase" : "sqlite", t: Date.now() });
}));

/* Ảnh đã tải lên (lưu trong DB) */
app.get("/img/:id", ah(async (req, res) => {
  const im = await one("SELECT mime,data FROM images WHERE id=?", [parseInt(req.params.id, 10) || 0]);
  if (!im) return res.status(404).end();
  res.setHeader("Content-Type", im.mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.end(Buffer.from(im.data, "base64"));
}));
app.post("/api/admin/upload", adminOnly, ah(async (req, res) => {
  const dataUrl = req.body.dataUrl || "";
  const m = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: "Ảnh không hợp lệ" });
  if (m[2].length > 1200000) return res.status(400).json({ error: "Ảnh quá lớn (tối đa ~800KB)" });
  const r = await one("INSERT INTO images(mime,data) VALUES(?,?) RETURNING id", [m[1], m[2]]);
  res.json({ url: "/img/" + r.id });
}));

/* ---------- Public ---------- */
app.get("/api/config", ah(async (req, res) =>
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, demoPay: !sepayOn, prices: await prices() })));

app.get("/api/curriculum", ah(async (req, res) => {
  const gs = await q("SELECT * FROM grades ORDER BY sort,id");
  const grades = [];
  for (const g of gs) {
    const us = await q("SELECT * FROM units WHERE grade_id=? ORDER BY sort,id", [g.id]);
    const units = [];
    for (const u of us) {
      units.push({
        name: u.name, emoji: u.emoji, description: u.description, pro: !!u.pro,
        words: await q("SELECT en,vi,ipa,img,audio FROM words WHERE unit_id=? ORDER BY sort,id", [u.id]),
      });
    }
    grades.push({ grade: g.name, icon: g.icon, units });
  }
  res.json({ grades });
}));

app.post("/api/register", ah(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: "Invalid email" });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password: at least 6 characters" });
  if (await one("SELECT id FROM users WHERE email=?", [email.toLowerCase()]))
    return res.status(400).json({ error: "Email already registered" });
  const r = await one("INSERT INTO users(email,pass_hash,name) VALUES(?,?,?) RETURNING id",
    [email.toLowerCase(), bcrypt.hashSync(password, 10), (name || "").slice(0, 50)]);
  const u = await one("SELECT * FROM users WHERE id=?", [r.id]);
  const kicked = !!u.sid;
  await setToken(res, u);
  res.json({ ...safeUser(u), kicked });
}));

app.post("/api/login", ah(async (req, res) => {
  const u = await one("SELECT * FROM users WHERE email=?", [(req.body.email || "").toLowerCase()]);
  if (!u || !u.pass_hash || !bcrypt.compareSync(req.body.password || "", u.pass_hash))
    return res.status(400).json({ error: "Wrong email or password" });
  const kicked = !!u.sid;
  await setToken(res, u);
  res.json({ ...safeUser(u), kicked });
}));

const gClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
app.post("/api/google", ah(async (req, res) => {
  if (!gClient) return res.status(400).json({ error: "Google sign-in not configured" });
  try {
    const t = await gClient.verifyIdToken({ idToken: req.body.credential, audience: GOOGLE_CLIENT_ID });
    const p = t.getPayload();
    let u = await one("SELECT * FROM users WHERE google_id=? OR email=?", [p.sub, p.email.toLowerCase()]);
    if (!u) {
      const r = await one("INSERT INTO users(email,name,google_id) VALUES(?,?,?) RETURNING id",
        [p.email.toLowerCase(), p.name || "", p.sub]);
      u = await one("SELECT * FROM users WHERE id=?", [r.id]);
    } else if (!u.google_id) {
      await q("UPDATE users SET google_id=? WHERE id=?", [p.sub, u.id]);
    }
    const kicked = !!u.sid;
    await setToken(res, u);
    res.json({ ...safeUser(u), kicked });
  } catch (e) { res.status(400).json({ error: "Google sign-in failed" }); }
}));

app.get("/api/me", auth, (req, res) => res.json(safeUser(req.user)));
app.post("/api/logout", ah(async (req, res) => {
  try {
    const { uid } = jwt.verify(req.cookies.pipi_token, JWT_SECRET);
    await q("UPDATE users SET sid=NULL WHERE id=?", [uid]);
  } catch (e) {}
  res.clearCookie("pipi_token");
  res.json({ ok: true });
}));

/* Gói Basic chọn 1 lớp — một lần duy nhất */
app.post("/api/choose-grade", auth, ah(async (req, res) => {
  const su = safeUser(req.user);
  if (su.plan !== "basic") return res.status(400).json({ error: "Only for Basic plan" });
  if (req.user.basic_grade !== null && req.user.basic_grade !== undefined)
    return res.status(400).json({ error: "You already chose your grade" });
  const g = parseInt(req.body.grade, 10);
  const count = Number((await one("SELECT COUNT(*) AS c FROM grades")).c);
  if (!(g >= 0 && g < count)) return res.status(400).json({ error: "Invalid grade" });
  await q("UPDATE users SET basic_grade=? WHERE id=?", [g, req.user.id]);
  res.json({ ok: true, basicGrade: g });
}));

app.get("/api/progress", auth, ah(async (req, res) =>
  res.json({ items: await q("SELECT k,stars FROM progress WHERE user_id=?", [req.user.id]) })));
app.post("/api/progress", auth, ah(async (req, res) => {
  const { k, stars } = req.body || {};
  if (typeof k !== "string" || k.length > 40 || ![1, 2, 3].includes(stars))
    return res.status(400).json({ error: "Bad data" });
  await q(`INSERT INTO progress(user_id,k,stars) VALUES(?,?,?)
    ON CONFLICT(user_id,k) DO UPDATE SET stars=${D.maxStars}`, [req.user.id, k, stars]);
  res.json({ ok: true });
}));

/* ---------- Thanh toán SePay ---------- */
app.post("/api/pay/create", auth, ah(async (req, res) => {
  const plan = PLANS.includes(req.body.plan) ? req.body.plan : "premium";
  const cur = safeUser(req.user).plan;
  if (cur === "family" || cur === plan) return res.json({ already: true });
  const amount = await planPrice(plan);
  if (!sepayOn) {
    await q("UPDATE users SET pro=1, plan=?, basic_grade=NULL WHERE id=?", [plan, req.user.id]);
    await q("INSERT INTO payments(order_code,user_id,amount,status,channel,plan) VALUES(?,?,?,?,?,?)",
      [Number(String(Date.now()).slice(-9)), req.user.id, amount, "paid", "direct", plan]);
    return res.json({ demo: true });
  }
  const orderCode = Number(String(Date.now()).slice(-9));
  await q("INSERT INTO payments(order_code,user_id,amount,plan) VALUES(?,?,?,?)", [orderCode, req.user.id, amount, plan]);
  const code = "PIPI" + orderCode;
  const qrUrl = "https://qr.sepay.vn/img?acc=" + encodeURIComponent(SEPAY_ACC)
    + "&bank=" + encodeURIComponent(SEPAY_BANK)
    + "&amount=" + amount + "&des=" + encodeURIComponent(code);
  res.json({ orderCode, code, amount, qrUrl });
}));

app.get("/api/pay/status", auth, ah(async (req, res) => {
  const p = await one("SELECT status FROM payments WHERE order_code=? AND user_id=?",
    [parseInt(req.query.oc, 10) || 0, req.user.id]);
  res.json({ paid: !!(p && p.status === "paid") });
}));

app.post("/api/pay/webhook/sepay", ah(async (req, res) => {
  const authH = req.headers["authorization"] || "";
  if (!sepayOn || authH !== "Apikey " + SEPAY_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const content = (b.content || b.description || "") + "";
  const amountIn = Number(b.transferAmount || b.amount || 0);
  const m = content.match(/PIPI\s*(\d{6,12})/i);
  if (m && (b.transferType === undefined || b.transferType === "in")) {
    const oc = Number(m[1]);
    const pay = await one("SELECT * FROM payments WHERE order_code=?", [oc]);
    if (pay && pay.status !== "paid" && amountIn >= pay.amount) {
      await q("UPDATE payments SET status='paid' WHERE order_code=?", [oc]);
      const plan = PLANS.includes(pay.plan) ? pay.plan : "premium";
      if (plan === "family")
        await q("UPDATE users SET pro=1, plan='family', pro_until=NULL, basic_grade=NULL WHERE id=?", [pay.user_id]);
      else
        await q(`UPDATE users SET pro=1, plan=?, pro_until=${usePg ? "(" + D.plus1y + ")::text" : D.plus1y}, basic_grade=NULL WHERE id=?`, [plan, pay.user_id]);
    }
  }
  res.json({ success: true });
}));

/* ---------- ADMIN ---------- */
app.get("/api/admin/me", adminOnly, (req, res) => res.json(safeUser(req.user)));

app.get("/api/admin/users", adminOnly, ah(async (req, res) => {
  const s = "%" + (req.query.q || "") + "%";
  res.json({
    users: await q(
      `SELECT id,email,name,pro,plan,basic_grade,${D.created} AS created_at
       FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 500`, [s, s]),
  });
}));
app.post("/api/admin/users/:id/plan", adminOnly, ah(async (req, res) => {
  const plan = ["free", "basic", "premium", "family"].includes(req.body.plan) ? req.body.plan : "free";
  await q("UPDATE users SET plan=?, pro=?, basic_grade=NULL WHERE id=?",
    [plan, plan === "free" ? 0 : 1, req.params.id]);
  res.json({ ok: true });
}));

app.get("/api/admin/revenue", adminOnly, ah(async (req, res) => {
  const t = await one("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM payments WHERE status='paid'");
  const month = await one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='paid' AND ${D.month}`);
  const today = await one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='paid' AND ${D.today}`);
  const rows = await q(`SELECT p.order_code, u.email, p.plan, p.amount, p.channel, p.status, ${usePg ? "to_char(p.created_at,'YYYY-MM-DD HH24:MI')" : "p.created_at"} AS created_at
    FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 1000`);
  res.json({ totals: { all: +t.s, count: +t.c, month: +month.s, today: +today.s }, rows });
}));

app.get("/api/admin/revenue.xlsx", adminOnly, ah(async (req, res) => {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Doanh thu");
  ws.columns = [
    { header: "Mã đơn", key: "order_code", width: 14 }, { header: "Email khách", key: "email", width: 30 },
    { header: "Gói", key: "plan", width: 12 }, { header: "Số tiền (VND)", key: "amount", width: 16 },
    { header: "Kênh", key: "channel", width: 10 }, { header: "Trạng thái", key: "status", width: 12 },
    { header: "Thời gian", key: "created_at", width: 22 }];
  ws.getRow(1).font = { bold: true };
  const rows = await q(`SELECT p.order_code, u.email, p.plan, p.amount, p.channel, p.status, ${usePg ? "to_char(p.created_at,'YYYY-MM-DD HH24:MI')" : "p.created_at"} AS created_at
    FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC`);
  rows.forEach(r => ws.addRow(r));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="pipi-doanhthu.xlsx"');
  await wb.xlsx.write(res); res.end();
}));

app.get("/api/admin/settings", adminOnly, ah(async (req, res) => res.json(await prices())));
app.post("/api/admin/settings", adminOnly, ah(async (req, res) => {
  const b = req.body || {};
  for (const p of PLANS) {
    const sale = parseInt(b["price_" + p], 10), list = parseInt(b["list_" + p], 10);
    if (sale >= 1000) await setSetting("price_" + p, sale);
    if (list >= 1000) await setSetting("list_" + p, list);
  }
  res.json({ ok: true, ...(await prices()) });
}));

/* CRUD nội dung */
app.get("/api/admin/content", adminOnly, ah(async (req, res) =>
  res.json({ grades: await q("SELECT * FROM grades ORDER BY sort,id") })));
app.get("/api/admin/units/:gid", adminOnly, ah(async (req, res) =>
  res.json({ units: await q("SELECT * FROM units WHERE grade_id=? ORDER BY sort,id", [req.params.gid]) })));
app.get("/api/admin/words/:uid", adminOnly, ah(async (req, res) =>
  res.json({ words: await q("SELECT * FROM words WHERE unit_id=? ORDER BY sort,id", [req.params.uid]) })));

app.post("/api/admin/grade", adminOnly, ah(async (req, res) => {
  const r = await one("INSERT INTO grades(name,icon,sort) VALUES(?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM grades g2)) RETURNING id",
    [req.body.name || "New Grade", req.body.icon || "🐣"]);
  res.json({ id: r.id });
}));
app.patch("/api/admin/grade/:id", adminOnly, ah(async (req, res) => {
  await q("UPDATE grades SET name=?, icon=? WHERE id=?", [req.body.name, req.body.icon, req.params.id]);
  res.json({ ok: true });
}));
app.delete("/api/admin/grade/:id", adminOnly, ah(async (req, res) => {
  const gid = req.params.id;
  await q("DELETE FROM words WHERE unit_id IN (SELECT id FROM units WHERE grade_id=?)", [gid]);
  await q("DELETE FROM units WHERE grade_id=?", [gid]);
  await q("DELETE FROM grades WHERE id=?", [gid]);
  res.json({ ok: true });
}));

app.post("/api/admin/unit", adminOnly, ah(async (req, res) => {
  const { grade_id, name, emoji, description, pro } = req.body;
  const r = await one(`INSERT INTO units(grade_id,name,emoji,description,pro,sort)
    VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM units u2 WHERE u2.grade_id=?)) RETURNING id`,
    [grade_id, name || "New Unit", emoji || "⭐", description || "", pro ? 1 : 0, grade_id]);
  res.json({ id: r.id });
}));
app.patch("/api/admin/unit/:id", adminOnly, ah(async (req, res) => {
  const { name, emoji, description, pro } = req.body;
  await q("UPDATE units SET name=?, emoji=?, description=?, pro=? WHERE id=?",
    [name, emoji, description || "", pro ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));
app.delete("/api/admin/unit/:id", adminOnly, ah(async (req, res) => {
  await q("DELETE FROM words WHERE unit_id=?", [req.params.id]);
  await q("DELETE FROM units WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

app.post("/api/admin/word", adminOnly, ah(async (req, res) => {
  const { unit_id, en, vi, ipa, img, audio } = req.body;
  if (!en) return res.status(400).json({ error: "Thiếu từ tiếng Anh" });
  const r = await one(`INSERT INTO words(unit_id,en,vi,ipa,img,audio,sort)
    VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM words w2 WHERE w2.unit_id=?)) RETURNING id`,
    [unit_id, en, vi || "", ipa || "", img || "⭐", audio || "", unit_id]);
  res.json({ id: r.id });
}));
app.patch("/api/admin/word/:id", adminOnly, ah(async (req, res) => {
  const { en, vi, ipa, img, audio } = req.body;
  await q("UPDATE words SET en=?, vi=?, ipa=?, img=?, audio=? WHERE id=?",
    [en, vi || "", ipa || "", img || "", audio || "", req.params.id]);
  res.json({ ok: true });
}));
app.delete("/api/admin/word/:id", adminOnly, ah(async (req, res) => {
  await q("DELETE FROM words WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- Khởi động ---------- */
process.on("unhandledRejection", err => console.error("UnhandledRejection (đã bắt):", err && err.message || err));
process.on("uncaughtException", err => console.error("UncaughtException (đã bắt):", err && err.message || err));

initDb().then(() => {
  const server = app.listen(PORT, () => {
    console.log("🐥 PiPi English v3 chạy tại " + BASE_URL);
    console.log("   Lưu trữ:        " + (usePg ? "SUPABASE POSTGRES ☁️ (vĩnh viễn)" : "SQLite file (local)"));
    console.log("   Google Sign-In: " + (GOOGLE_CLIENT_ID ? "BẬT" : "TẮT"));
    console.log("   SePay:          " + (sepayOn ? "BẬT (QR thật)" : "chưa cấu hình"));
    console.log("   Admin:          " + (ADMIN_EMAILS.length ? ADMIN_EMAILS.join(", ") : "CHƯA ĐẶT ADMIN_EMAILS"));
  });
  /* Proxy của Render giữ kết nối lâu hơn 5s mặc định của Node —
     Node đóng trước → proxy dùng lại kết nối chết → 502. Nâng lên 120s. */
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 121000; // luôn phải > keepAliveTimeout
}).catch(err => { console.error("❌ Không kết nối được CSDL:", err.message); process.exit(1); });

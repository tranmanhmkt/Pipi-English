/* ============================================================
   PiPi English — Backend v2
   Auth (email + Google) · SePay VietQR · Admin · Curriculum DB
   ============================================================ */
const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { OAuth2Client } = require("google-auth-library");

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-doi-khi-len-production";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:" + PORT;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s=>s.trim()).filter(Boolean);
/* SePay: thiếu 1 trong 3 biến => chế độ DEMO (bấm Pay là lên PRO) */
const SEPAY_BANK = process.env.SEPAY_BANK || "";      // vd: MBBank, VCB, ACB...
const SEPAY_ACC  = process.env.SEPAY_ACC || "";       // số tài khoản nhận tiền
const SEPAY_API_KEY = process.env.SEPAY_API_KEY || ""; // API key webhook trong SePay
const sepayOn = !!(SEPAY_BANK && SEPAY_ACC && SEPAY_API_KEY);

/* ---------- DB ---------- */
const db = new Database(process.env.DB_PATH || path.join(__dirname, "pipi.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
  pass_hash TEXT, name TEXT, google_id TEXT,
  pro INTEGER DEFAULT 0, pro_until TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS progress(user_id INTEGER, k TEXT, stars INTEGER, PRIMARY KEY(user_id,k));
CREATE TABLE IF NOT EXISTS payments(
  order_code INTEGER PRIMARY KEY, user_id INTEGER, amount INTEGER,
  status TEXT DEFAULT 'pending', channel TEXT DEFAULT 'sepay',
  created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS grades(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, icon TEXT, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS units(
  id INTEGER PRIMARY KEY AUTOINCREMENT, grade_id INTEGER, name TEXT, emoji TEXT,
  description TEXT DEFAULT '', pro INTEGER DEFAULT 0, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS words(
  id INTEGER PRIMARY KEY AUTOINCREMENT, unit_id INTEGER,
  en TEXT, vi TEXT DEFAULT '', ipa TEXT DEFAULT '', img TEXT DEFAULT '', audio TEXT DEFAULT '', sort INTEGER DEFAULT 0);
`);

/* Seed nội dung lần đầu từ seed-curriculum.json */
if (db.prepare("SELECT COUNT(*) c FROM grades").get().c === 0) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-curriculum.json"), "utf8"));
  const insG = db.prepare("INSERT INTO grades(name,icon,sort) VALUES(?,?,?)");
  const insU = db.prepare("INSERT INTO units(grade_id,name,emoji,description,pro,sort) VALUES(?,?,?,?,?,?)");
  const insW = db.prepare("INSERT INTO words(unit_id,en,vi,ipa,img,audio,sort) VALUES(?,?,?,?,?,?,?)");
  const tx = db.transaction(() => {
    seed.grades.forEach(g => {
      const gid = insG.run(g.name, g.icon, g.sort).lastInsertRowid;
      g.units.forEach(u => {
        const uid = insU.run(gid, u.name, u.emoji, u.description||"", u.pro?1:0, u.sort).lastInsertRowid;
        u.words.forEach(w => insW.run(uid, w.en, w.vi, w.ipa, w.img, w.audio||"", w.sort));
      });
    });
  });
  tx();
  console.log("🌱 Đã nạp nội dung mẫu: 5 lớp / 105 unit / 630 từ");
}
try{ db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'"); }catch(e){}
try{ db.exec("ALTER TABLE payments ADD COLUMN plan TEXT DEFAULT 'premium'"); }catch(e){}
db.prepare("UPDATE users SET plan='premium' WHERE pro=1 AND (plan IS NULL OR plan='free')").run();

const getSetting = k => { const r=db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r?r.value:null; };
const setSetting = (k,v) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v));
/* Giá bán & giá niêm yết từng gói (admin sửa được) */
const PRICE_DEFAULTS = {
  price_basic:"149000",  list_basic:"499000",
  price_premium:"299000",list_premium:"799000",
  price_family:"499000", list_family:"1999000",
};
for(const k in PRICE_DEFAULTS) if(!getSetting(k)) setSetting(k, PRICE_DEFAULTS[k]);
/* Chính sách Free mới: chỉ Unit 1 của Grade 1 miễn phí (chạy đúng 1 lần trên DB cũ) */
if(!getSetting("mig_free_only_first")){
  const firstUnit=db.prepare(`SELECT u.id FROM units u JOIN grades g ON g.id=u.grade_id
    ORDER BY g.sort,g.id,u.sort,u.id LIMIT 1`).get();
  if(firstUnit){
    db.prepare("UPDATE units SET pro=1 WHERE id<>?").run(firstUnit.id);
    db.prepare("UPDATE units SET pro=0 WHERE id=?").run(firstUnit.id);
  }
  setSetting("mig_free_only_first","1");
}
const PLANS = ["basic","premium","family"];
const planPrice = p => parseInt(getSetting("price_"+p),10) || 0;
const prices = () => ({
  basic:  { list:+getSetting("list_basic"),   sale:+getSetting("price_basic") },
  premium:{ list:+getSetting("list_premium"), sale:+getSetting("price_premium") },
  family: { list:+getSetting("list_family"),  sale:+getSetting("price_family") },
});

/* ---------- App ---------- */
const app = express();
app.use(express.json({limit:"1mb"}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));

const safeUser = u => {
  const plan = u.plan && u.plan!=="free" ? u.plan : (u.pro ? "premium" : "free");
  return { email:u.email, name:u.name||"", plan, pro:plan!=="free", admin:ADMIN_EMAILS.includes(u.email) };
};
function setToken(res,u){
  res.cookie("pipi_token", jwt.sign({uid:u.id}, JWT_SECRET, {expiresIn:"30d"}),
    {httpOnly:true, sameSite:"lax", secure:IS_PROD, maxAge:30*24*3600*1000});
}
function auth(req,res,next){
  try{
    const {uid}=jwt.verify(req.cookies.pipi_token, JWT_SECRET);
    req.user=db.prepare("SELECT * FROM users WHERE id=?").get(uid);
    if(!req.user) throw 0; next();
  }catch(e){ res.status(401).json({error:"Please sign in"}); }
}
function adminOnly(req,res,next){
  auth(req,res,()=>{ 
    if(!ADMIN_EMAILS.includes(req.user.email)) return res.status(403).json({error:"Admin only"});
    next();
  });
}

/* ---------- Public APIs ---------- */
app.get("/api/config",(req,res)=>res.json({googleClientId:GOOGLE_CLIENT_ID||null, demoPay:!sepayOn, prices:prices()}));

app.get("/api/curriculum",(req,res)=>{
  const grades=db.prepare("SELECT * FROM grades ORDER BY sort,id").all().map(g=>({
    grade:g.name, icon:g.icon,
    units:db.prepare("SELECT * FROM units WHERE grade_id=? ORDER BY sort,id").all(g.id).map(u=>({
      name:u.name, emoji:u.emoji, description:u.description, pro:!!u.pro,
      words:db.prepare("SELECT en,vi,ipa,img,audio FROM words WHERE unit_id=? ORDER BY sort,id").all(u.id)
    }))
  }));
  res.json({grades});
});

app.post("/api/register",(req,res)=>{
  const {email,password,name}=req.body||{};
  if(!email||!/.+@.+\..+/.test(email)) return res.status(400).json({error:"Invalid email"});
  if(!password||password.length<6) return res.status(400).json({error:"Password: at least 6 characters"});
  if(db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase()))
    return res.status(400).json({error:"Email already registered"});
  const info=db.prepare("INSERT INTO users(email,pass_hash,name) VALUES(?,?,?)")
    .run(email.toLowerCase(), bcrypt.hashSync(password,10), (name||"").slice(0,50));
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
  setToken(res,u); res.json(safeUser(u));
});
app.post("/api/login",(req,res)=>{
  const u=db.prepare("SELECT * FROM users WHERE email=?").get((req.body.email||"").toLowerCase());
  if(!u||!u.pass_hash||!bcrypt.compareSync(req.body.password||"",u.pass_hash))
    return res.status(400).json({error:"Wrong email or password"});
  setToken(res,u); res.json(safeUser(u));
});
const gClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
app.post("/api/google", async (req,res)=>{
  if(!gClient) return res.status(400).json({error:"Google sign-in not configured"});
  try{
    const t=await gClient.verifyIdToken({idToken:req.body.credential, audience:GOOGLE_CLIENT_ID});
    const p=t.getPayload();
    let u=db.prepare("SELECT * FROM users WHERE google_id=? OR email=?").get(p.sub, p.email.toLowerCase());
    if(!u){
      const info=db.prepare("INSERT INTO users(email,name,google_id) VALUES(?,?,?)").run(p.email.toLowerCase(), p.name||"", p.sub);
      u=db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
    } else if(!u.google_id) db.prepare("UPDATE users SET google_id=? WHERE id=?").run(p.sub,u.id);
    setToken(res,u); res.json(safeUser(u));
  }catch(e){ res.status(400).json({error:"Google sign-in failed"}); }
});
app.get("/api/me", auth, (req,res)=>res.json(safeUser(req.user)));
app.post("/api/logout",(req,res)=>{res.clearCookie("pipi_token");res.json({ok:true});});

app.get("/api/progress", auth, (req,res)=>res.json({items:db.prepare("SELECT k,stars FROM progress WHERE user_id=?").all(req.user.id)}));
app.post("/api/progress", auth, (req,res)=>{
  const {k,stars}=req.body||{};
  if(typeof k!=="string"||k.length>40||![1,2,3].includes(stars)) return res.status(400).json({error:"Bad data"});
  db.prepare("INSERT INTO progress(user_id,k,stars) VALUES(?,?,?) ON CONFLICT(user_id,k) DO UPDATE SET stars=MAX(stars,excluded.stars)").run(req.user.id,k,stars);
  res.json({ok:true});
});

/* ---------- Thanh toán SePay (VietQR tự sinh) ---------- */
app.post("/api/pay/create", auth, (req,res)=>{
  const plan = PLANS.includes(req.body.plan) ? req.body.plan : "premium";
  const cur = safeUser(req.user).plan;
  if(cur==="family" || cur===plan) return res.json({already:true});
  if(!sepayOn){
    db.prepare("UPDATE users SET pro=1, plan=? WHERE id=?").run(plan, req.user.id);
    db.prepare("INSERT INTO payments(order_code,user_id,amount,status,channel,plan) VALUES(?,?,?,?,?,?)")
      .run(Number(String(Date.now()).slice(-9)), req.user.id, planPrice(plan), "paid", "direct", plan);
    return res.json({demo:true});
  }
  const orderCode=Number(String(Date.now()).slice(-9));
  const amount=planPrice(plan);
  db.prepare("INSERT INTO payments(order_code,user_id,amount,plan) VALUES(?,?,?,?)").run(orderCode, req.user.id, amount, plan);
  const code="PIPI"+orderCode;
  const qrUrl="https://qr.sepay.vn/img?acc="+encodeURIComponent(SEPAY_ACC)
    +"&bank="+encodeURIComponent(SEPAY_BANK)
    +"&amount="+amount+"&des="+encodeURIComponent(code);
  res.json({orderCode, code, amount, qrUrl});
});
app.get("/api/pay/status", auth, (req,res)=>{
  const p=db.prepare("SELECT status FROM payments WHERE order_code=? AND user_id=?").get(Number(req.query.oc), req.user.id);
  res.json({paid: !!(p && p.status==="paid")});
});
/* SePay gọi webhook này khi có tiền vào tài khoản */
app.post("/api/pay/webhook/sepay",(req,res)=>{
  const authH=req.headers["authorization"]||"";
  if(!sepayOn || authH!=="Apikey "+SEPAY_API_KEY) return res.status(401).json({error:"Unauthorized"});
  const b=req.body||{};
  const content=(b.content||b.description||"")+"";
  const amountIn=Number(b.transferAmount||b.amount||0);
  const m=content.match(/PIPI(\d{6,12})/i);
  if(b.transferType==="in" && m){
    const oc=Number(m[1]);
    const pay=db.prepare("SELECT * FROM payments WHERE order_code=?").get(oc);
    if(pay && pay.status!=="paid" && amountIn>=pay.amount){
      db.prepare("UPDATE payments SET status='paid' WHERE order_code=?").run(oc);
      const plan = PLANS.includes(pay.plan) ? pay.plan : "premium";
      if(plan==="family")
        db.prepare("UPDATE users SET pro=1, plan='family', pro_until=NULL WHERE id=?").run(pay.user_id);
      else
        db.prepare("UPDATE users SET pro=1, plan=?, pro_until=date('now','+1 year') WHERE id=?").run(plan, pay.user_id);
    }
  }
  res.json({success:true});
});

/* ---------- ADMIN ---------- */
app.get("/api/admin/me", adminOnly, (req,res)=>res.json(safeUser(req.user)));

app.get("/api/admin/users", adminOnly, (req,res)=>{
  const q="%"+(req.query.q||"")+"%";
  res.json({users:db.prepare(
    "SELECT id,email,name,pro,plan,created_at FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 500"
  ).all(q,q)});
});
app.post("/api/admin/users/:id/plan", adminOnly, (req,res)=>{
  const plan = ["free","basic","premium","family"].includes(req.body.plan) ? req.body.plan : "free";
  db.prepare("UPDATE users SET plan=?, pro=? WHERE id=?").run(plan, plan==="free"?0:1, req.params.id);
  res.json({ok:true});
});

app.get("/api/admin/revenue", adminOnly, (req,res)=>{
  const t=db.prepare("SELECT COALESCE(SUM(amount),0) s, COUNT(*) c FROM payments WHERE status='paid'").get();
  const month=db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now','localtime')").get();
  const today=db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid' AND date(created_at)=date('now','localtime')").get();
  const rows=db.prepare(`SELECT p.order_code, u.email, p.amount, p.plan, p.channel, p.status, p.created_at
    FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 1000`).all();
  res.json({totals:{all:t.s, count:t.c, month:month.s, today:today.s}, rows});
});
app.get("/api/admin/revenue.xlsx", adminOnly, async (req,res)=>{
  const ExcelJS=require("exceljs");
  const wb=new ExcelJS.Workbook();
  const ws=wb.addWorksheet("Doanh thu");
  ws.columns=[
    {header:"Mã đơn",key:"order_code",width:14},{header:"Email khách",key:"email",width:30},
    {header:"Gói",key:"plan",width:12},{header:"Số tiền (VND)",key:"amount",width:16},
    {header:"Kênh",key:"channel",width:10},{header:"Trạng thái",key:"status",width:12},
    {header:"Thời gian",key:"created_at",width:22}];
  ws.getRow(1).font={bold:true};
  db.prepare(`SELECT p.order_code, u.email, p.plan, p.amount, p.channel, p.status, p.created_at
    FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC`).all()
    .forEach(r=>ws.addRow(r));
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",'attachment; filename="pipi-doanhthu.xlsx"');
  await wb.xlsx.write(res); res.end();
});

app.get("/api/admin/settings", adminOnly, (req,res)=>res.json(prices()));
app.post("/api/admin/settings", adminOnly, (req,res)=>{
  const b=req.body||{};
  for(const p of PLANS){
    const sale=parseInt(b["price_"+p],10), list=parseInt(b["list_"+p],10);
    if(sale>=1000) setSetting("price_"+p, sale);
    if(list>=1000) setSetting("list_"+p, list);
  }
  res.json({ok:true, ...prices()});
});

/* CRUD nội dung */
app.get("/api/admin/content", adminOnly, (req,res)=>{
  res.json({grades:db.prepare("SELECT * FROM grades ORDER BY sort,id").all()});
});
app.get("/api/admin/units/:gid", adminOnly, (req,res)=>{
  res.json({units:db.prepare("SELECT * FROM units WHERE grade_id=? ORDER BY sort,id").all(req.params.gid)});
});
app.get("/api/admin/words/:uid", adminOnly, (req,res)=>{
  res.json({words:db.prepare("SELECT * FROM words WHERE unit_id=? ORDER BY sort,id").all(req.params.uid)});
});
app.post("/api/admin/grade", adminOnly, (req,res)=>{
  const {name,icon}=req.body;
  const id=db.prepare("INSERT INTO grades(name,icon,sort) VALUES(?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM grades))").run(name||"New Grade",icon||"🐣").lastInsertRowid;
  res.json({id});
});
app.patch("/api/admin/grade/:id", adminOnly, (req,res)=>{
  const {name,icon}=req.body;
  db.prepare("UPDATE grades SET name=?, icon=? WHERE id=?").run(name,icon,req.params.id); res.json({ok:true});
});
app.delete("/api/admin/grade/:id", adminOnly, (req,res)=>{
  const gid=req.params.id;
  db.prepare("DELETE FROM words WHERE unit_id IN (SELECT id FROM units WHERE grade_id=?)").run(gid);
  db.prepare("DELETE FROM units WHERE grade_id=?").run(gid);
  db.prepare("DELETE FROM grades WHERE id=?").run(gid); res.json({ok:true});
});
app.post("/api/admin/unit", adminOnly, (req,res)=>{
  const {grade_id,name,emoji,description,pro}=req.body;
  const id=db.prepare("INSERT INTO units(grade_id,name,emoji,description,pro,sort) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM units WHERE grade_id=?))")
    .run(grade_id, name||"New Unit", emoji||"⭐", description||"", pro?1:0, grade_id).lastInsertRowid;
  res.json({id});
});
app.patch("/api/admin/unit/:id", adminOnly, (req,res)=>{
  const {name,emoji,description,pro}=req.body;
  db.prepare("UPDATE units SET name=?, emoji=?, description=?, pro=? WHERE id=?")
    .run(name,emoji,description||"",pro?1:0,req.params.id); res.json({ok:true});
});
app.delete("/api/admin/unit/:id", adminOnly, (req,res)=>{
  db.prepare("DELETE FROM words WHERE unit_id=?").run(req.params.id);
  db.prepare("DELETE FROM units WHERE id=?").run(req.params.id); res.json({ok:true});
});
app.post("/api/admin/word", adminOnly, (req,res)=>{
  const {unit_id,en,vi,ipa,img,audio}=req.body;
  if(!en) return res.status(400).json({error:"Thiếu từ tiếng Anh"});
  const id=db.prepare("INSERT INTO words(unit_id,en,vi,ipa,img,audio,sort) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM words WHERE unit_id=?))")
    .run(unit_id,en,vi||"",ipa||"",img||"⭐",audio||"",unit_id).lastInsertRowid;
  res.json({id});
});
app.patch("/api/admin/word/:id", adminOnly, (req,res)=>{
  const {en,vi,ipa,img,audio}=req.body;
  db.prepare("UPDATE words SET en=?, vi=?, ipa=?, img=?, audio=? WHERE id=?")
    .run(en,vi||"",ipa||"",img||"",audio||"",req.params.id); res.json({ok:true});
});
app.delete("/api/admin/word/:id", adminOnly, (req,res)=>{
  db.prepare("DELETE FROM words WHERE id=?").run(req.params.id); res.json({ok:true});
});

app.listen(PORT,()=>{
  console.log("🐥 PiPi English v2 chạy tại "+BASE_URL);
  console.log("   Google Sign-In: "+(GOOGLE_CLIENT_ID?"BẬT":"TẮT"));
  console.log("   SePay:          "+(sepayOn?"BẬT (QR thật)":"DEMO (chưa cấu hình)"));
  console.log("   Admin:          "+(ADMIN_EMAILS.length?ADMIN_EMAILS.join(", "):"CHƯA ĐẶT ADMIN_EMAILS"));
});

// صفحة المدير: مراجعة طلبات الدفع وتفعيل الحسابات. الصلاحية الفعلية في firestore.rules (حساب المدير فقط).
import { watchAuth, googleLogin, emailLogin, resetPassword, logout, errorText } from "./auth.js";
import { getDb } from "./db.js";
import { isAdminUser, ADMIN_EMAIL } from "./billing.js";
import {
  collection, doc, onSnapshot, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const SCREENS = ["a-loading", "a-login", "a-main"];
const show = (id) => SCREENS.forEach((s) => $(s).classList.toggle("hidden", s !== id));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (t) => (t && t.toDate ? t.toDate().toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }) : "");

let unsub = null;

$("a-google").onclick = async () => {
  $("a-msg").textContent = "";
  try { await googleLogin(); } catch (e) { $("a-msg").textContent = errorText(e); }
};
$("a-logout").onclick = () => logout();

$("a-login-btn").onclick = async (e) => {
  const email = $("a-email").value.trim(), pass = $("a-pass").value;
  const msg = $("a-msg"); msg.className = "msg"; msg.textContent = "";
  if (!email || !pass) { msg.textContent = "اكتب البريد الإلكتروني وكلمة المرور."; return; }
  e.currentTarget.disabled = true;
  try { await emailLogin(email, pass); } catch (err) { msg.textContent = errorText(err); } finally { e.currentTarget.disabled = false; }
};

// الرابط يُرسل دائمًا إلى بريد المدير فقط، وكلمة المرور لا تتغير إلا بعد فتح الرابط واختيار كلمة جديدة
async function sendResetLink(msgEl) {
  msgEl.className = "msg";
  try {
    await resetPassword(ADMIN_EMAIL);
    msgEl.textContent = "أرسلنا رابط التأكيد إلى " + ADMIN_EMAIL + ". افتحه واختر كلمة المرور الجديدة، ولن تتغير كلمة المرور قبل ذلك. تحقق أيضًا من البريد غير الهام.";
    msgEl.className = "msg ok";
  } catch (err) { msgEl.textContent = errorText(err); }
}
$("a-forgot").onclick = () => sendResetLink($("a-msg"));
$("a-chpass").onclick = () => sendResetLink($("a-pass-msg"));

let curTab = "pending", q = "", lastList = [];
const PRICE_EGP = 100;
function badge(st) {
  const m = { pending: ["قيد المراجعة", "warn"], approved: ["مفعّل", "good"], rejected: ["مرفوض", "bad"], revoked: ["موقوف", "bad"] }[st] || [st, ""];
  return `<span class="pill ${m[1]}">${m[0]}</span>`;
}
function card(p, buttons) {
  const rows = [
    ["الاسم", p.name], ["رقم العملية / الهاتف", p.transfer],
    ["الرمز المرجعي", p.ref], ["وقت الطلب", when(p.createdAt)],
  ].map(([k, v]) => `<div class="row2"><span>${k}</span><span dir="auto">${esc(v)}</span></div>`).join("");
  const acts = buttons.map((b) => `<button class="btn ${b.cls}" data-act="${b.act}" data-uid="${esc(p.id)}" type="button">${b.label}</button>`).join("");
  return `<div class="adm-card"><div class="adm-head"><b dir="ltr">${esc(p.email)}</b>${badge(p.status)}</div>${rows}<div class="acts">${acts}</div></div>`;
}

function render(list) {
  lastList = list;
  const needle = q.trim().toLowerCase();
  const all = list;
  if (needle) list = list.filter((p) => [p.email, p.name, p.ref, p.transfer].some((v) => String(v || "").toLowerCase().includes(needle)));
  const by = (st) => list.filter((p) => p.status === st).sort((a, b) => ((b.createdAt && b.createdAt.toMillis && b.createdAt.toMillis()) || 0) - ((a.createdAt && a.createdAt.toMillis && a.createdAt.toMillis()) || 0));
  const pending = by("pending"), approved = by("approved");
  const other = list.filter((p) => p.status === "rejected" || p.status === "revoked");
  $("list-pending").innerHTML = pending.map((p) => card(p, [
    { act: "approve", label: "تفعيل", cls: "btn-in" },
    { act: "reject", label: "رفض", cls: "btn-ghost" },
  ])).join("");
  $("empty-pending").classList.toggle("hidden", pending.length > 0);
  $("list-approved").innerHTML = approved.map((p) => card(p, [{ act: "revoke", label: "إيقاف الاشتراك", cls: "btn-out" }])).join("");
  $("list-other").innerHTML = other.map((p) => card(p, [{ act: "approve", label: "تفعيل", cls: "btn-in" }])).join("");
  $("n-pending").textContent = pending.length || "";
  $("n-approved").textContent = approved.length || "";
  $("n-other").textContent = other.length || "";
  const ap = all.filter((p) => p.status === "approved").length;
  $("s-pending").textContent = all.filter((p) => p.status === "pending").length;
  $("s-approved").textContent = ap;
  $("s-revenue").textContent = ap * PRICE_EGP;
}
function showTab(t) {
  curTab = t;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.dataset.tab === t));
  ["pending", "approved", "other"].forEach((n) => $("panel-" + n).classList.toggle("hidden", n !== t));
}
document.querySelectorAll(".tab").forEach((x) => { x.onclick = () => showTab(x.dataset.tab); });
$("a-search").oninput = (e) => { q = e.target.value; render(lastList); };

let armed = null;
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const key = b.dataset.act + ":" + b.dataset.uid;
  if (armed !== key) { // أول ضغطة تطلب التأكيد
    armed = key;
    document.querySelectorAll("button[data-act]").forEach((x) => { x.textContent = x.dataset.label || x.textContent; });
    b.dataset.label = b.textContent;
    b.textContent = "تأكيد؟ اضغط مرة أخرى";
    return;
  }
  armed = null;
  b.disabled = true;
  const uid = b.dataset.uid, db = getDb();
  const payRef = doc(db, "payments", uid), paidRef = doc(db, "users", uid, "account", "paid");
  try {
    const batch = writeBatch(db);
    if (b.dataset.act === "approve") {
      batch.set(paidRef, { approvedAt: serverTimestamp(), by: ADMIN_EMAIL });
      batch.update(payRef, { status: "approved", reviewedAt: serverTimestamp() });
    } else if (b.dataset.act === "reject") {
      batch.update(payRef, { status: "rejected", reviewedAt: serverTimestamp() });
    } else if (b.dataset.act === "revoke") {
      batch.delete(paidRef);
      batch.update(payRef, { status: "revoked", reviewedAt: serverTimestamp() });
    }
    await batch.commit();
    $("a-err").textContent = "";
  } catch (err) {
    $("a-err").textContent = "تعذّر تنفيذ العملية: " + (err.code || err.message);
    b.disabled = false;
  }
});

watchAuth((user) => {
  if (unsub) { unsub(); unsub = null; }
  if (!user) { show("a-login"); return; }
  if (!isAdminUser(user)) {
    show("a-login");
    $("a-msg").textContent = "هذا الحساب (" + (user.email || "") + ") غير مصرّح له بدخول الإدارة. اخرج وادخل بحساب المدير.";
    logout();
    return;
  }
  show("a-main");
  $("a-who").textContent = user.email;
  $("a-pass-msg").textContent = "";
  unsub = onSnapshot(collection(getDb(), "payments"), (snap) => {
    render(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => { $("a-err").textContent = "تعذّر تحميل الطلبات: " + (err.code || err.message); });
});

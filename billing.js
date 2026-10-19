// الاشتراك: تجربة مجانية ساعتان، ثم قفل كامل حتى يفعّل المدير الحساب بعد التحقق من تحويل إنستاباي.
// المسارات في Firestore:
//   users/{uid}/account/trial  ← { trialStartedAt }   (يُنشأ مرة واحدة، ولا يمكن تعديله)
//   users/{uid}/account/paid   ← { approvedAt }       (يكتبه المدير فقط)
//   payments/{uid}             ← طلب الدفع { uid, email, name, transfer, ref, status, createdAt }
// القفل الحقيقي في firestore.rules، وما هنا مجرد عرض للواجهة.
import { getDb } from "./db.js";
import { doc, onSnapshot, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export const ADMIN_EMAIL = "medsyncplus@gmail.com";
export const IPA = "didamony372@instapay";
export const PRICE = 100;
export const TRIAL_MS = 2 * 60 * 60 * 1000;

export const isAdminUser = (u) => !!u && String(u.email || "").toLowerCase() === ADMIN_EMAIL;

// رمز مرجعي من ٦ أرقام، يكتبه المشترك في ملاحظة التحويل ليسهل على المدير مطابقة الطلب
export function refCode(uid) {
  let h = 0;
  for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return String((h % 900000) + 100000);
}

// cb({ state: 'loading' | 'trial' | 'paid' | 'locked' | 'error', msLeft?, admin? })
export function watchAccess(user, cb) {
  const uid = user.uid;
  const admin = isAdminUser(user);
  if (admin) { cb({ state: "paid", admin: true }); return () => {}; }

  const db = getDb();
  const trial = { ready: false, exists: false, startMs: 0 };
  const paid = { ready: false, exists: false };
  let timer = null, failTimer = null, stopped = false, creating = false;

  const compute = () => {
    if (stopped) return;
    clearTimeout(timer);
    if (!paid.ready || !trial.ready) return;
    clearTimeout(failTimer);
    if (paid.exists) return cb({ state: "paid" });
    if (trial.exists) {
      const left = trial.startMs + TRIAL_MS - Date.now();
      if (left > 0) {
        cb({ state: "trial", msLeft: left });
        timer = setTimeout(compute, Math.min(left + 300, 20000));
        return;
      }
    }
    cb({ state: "locked" });
  };
  const fail = () => { if (!stopped) cb({ state: "error" }); };
  failTimer = setTimeout(fail, 8000);

  const trialRef = doc(db, "users", uid, "account", "trial");
  const u1 = onSnapshot(trialRef, { includeMetadataChanges: true }, (snap) => {
    if (snap.exists()) {
      const ts = snap.data({ serverTimestamps: "estimate" }).trialStartedAt;
      trial.exists = true;
      trial.startMs = ts && ts.toMillis ? ts.toMillis() : Date.now();
      trial.ready = true;
    } else if (!snap.metadata.fromCache) {
      trial.exists = false;
      trial.ready = true;
      if (!creating) {
        creating = true;
        setDoc(trialRef, { trialStartedAt: serverTimestamp() }).catch(() => { creating = false; });
      }
    }
    compute();
  }, fail);
  const u2 = onSnapshot(doc(db, "users", uid, "account", "paid"), { includeMetadataChanges: true }, (snap) => {
    if (snap.exists() || !snap.metadata.fromCache) { paid.exists = snap.exists(); paid.ready = true; }
    compute();
  }, fail);
  return () => { stopped = true; clearTimeout(timer); clearTimeout(failTimer); u1(); u2(); };
}

export function watchPayment(uid, cb) {
  return onSnapshot(doc(getDb(), "payments", uid), (snap) => cb(snap.exists() ? snap.data() : null), () => cb(null));
}

export function submitPayment(user, { name, transfer }) {
  return setDoc(doc(getDb(), "payments", user.uid), {
    uid: user.uid,
    email: user.email || "",
    name,
    transfer,
    ref: refCode(user.uid),
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

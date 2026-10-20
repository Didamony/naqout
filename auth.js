// الخطوة 2: تسجيل الدخول بـ Firebase Authentication.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

export const configured = !String(firebaseConfig.apiKey || "").startsWith("YOUR_");

export let app = null;
let auth = null;
if (configured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  auth.languageCode = "ar"; // رسايل إيميل إعادة تعيين كلمة السر بالعربي
}

// بينادي cb(user) أول ما يعرف حالة الدخول، وبعد كل دخول أو خروج. user = null لو مش مسجل.
export function watchAuth(cb) {
  if (!auth) { cb(null); return; }
  onAuthStateChanged(auth, cb);
}

export async function googleLogin() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    // بعض الموبايلات والتطبيقات المثبتة بتمنع النوافذ المنبثقة، فنكمل بالتحويل
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw e;
  }
}

export const emailLogin = (email, pass) => signInWithEmailAndPassword(auth, email, pass);
// التسجيل بالبريد: ننشئ الحساب ثم نرسل رسالة تأكيد إلى البريد (لا يُفتح الدفتر قبل التأكيد)
export async function emailRegister(email, pass) {
  const cred = await createUserWithEmailAndPassword(auth, email, pass);
  try { await sendEmailVerification(cred.user); } catch (e) { /* يمكنه طلب الرسالة مرة أخرى من شاشة التأكيد */ }
  return cred;
}
export const resendVerification = () => sendEmailVerification(auth.currentUser);
// بعد فتح رابط التأكيد من البريد: نحدّث بيانات المستخدم والتوكن ليعرف الخادم أن البريد مؤكَّد
export async function reloadCurrentUser() {
  const u = auth.currentUser;
  if (!u) return null;
  await u.reload();
  await u.getIdToken(true);
  return auth.currentUser;
}
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const logout = () => signOut(auth);

const MESSAGES = {
  "auth/invalid-email": "البريد الإلكتروني غير صحيح.",
  "auth/missing-password": "اكتب كلمة المرور.",
  "auth/invalid-credential": "البريد الإلكتروني أو كلمة المرور غير صحيحة. إن كنت سجّلت بحساب جوجل فاستخدم زر جوجل.",
  "auth/wrong-password": "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  "auth/user-not-found": "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  "auth/email-already-in-use": "لهذا البريد حساب بالفعل. سجّل الدخول، أو اضغط \"نسيت كلمة المرور؟\".",
  "auth/weak-password": "كلمة المرور ضعيفة. اجعلها 12 خانة على الأقل، وتجمع بين الحروف والأرقام.",
  "auth/too-many-requests": "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
  "auth/network-request-failed": "لا يوجد اتصال بالإنترنت.",
  "auth/unauthorized-domain": "هذا العنوان غير مضاف في Firebase (Authentication ← Settings ← Authorized domains).",
  "auth/operation-not-allowed": "طريقة الدخول هذه غير مفعّلة في Firebase (Authentication ← Sign-in method).",
  "auth/popup-closed-by-user": "",
  "auth/cancelled-popup-request": "",
};

export function errorText(e) {
  const code = e && e.code;
  if (code in MESSAGES) return MESSAGES[code];
  return "حدثت مشكلة" + (code ? " (" + code + ")" : "") + ". حاول مرة أخرى.";
}

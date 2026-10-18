// الخطوة 2: تسجيل الدخول بـ Firebase Authentication.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
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
export const emailRegister = (email, pass) => createUserWithEmailAndPassword(auth, email, pass);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const logout = () => signOut(auth);

const MESSAGES = {
  "auth/invalid-email": "الإيميل مكتوب غلط.",
  "auth/missing-password": "اكتب كلمة السر.",
  "auth/invalid-credential": "الإيميل أو كلمة السر غلط. لو سجلت بحساب جوجل استخدم زرار جوجل.",
  "auth/wrong-password": "الإيميل أو كلمة السر غلط.",
  "auth/user-not-found": "الإيميل أو كلمة السر غلط.",
  "auth/email-already-in-use": "الإيميل ده عنده حساب بالفعل. سجّل دخول، أو اضغط \"نسيت كلمة السر؟\".",
  "auth/weak-password": "كلمة السر ضعيفة. لازم 6 حروف أو أرقام على الأقل.",
  "auth/too-many-requests": "محاولات كتير. استنى شوية وجرّب تاني.",
  "auth/network-request-failed": "مفيش اتصال بالنت.",
  "auth/unauthorized-domain": "العنوان ده مش مضاف في Firebase (Authentication ← Settings ← Authorized domains).",
  "auth/operation-not-allowed": "طريقة الدخول دي مش مفعّلة في Firebase (Authentication ← Sign-in method).",
  "auth/popup-closed-by-user": "",
  "auth/cancelled-popup-request": "",
};

export function errorText(e) {
  const code = e && e.code;
  if (code in MESSAGES) return MESSAGES[code];
  return "حصلت مشكلة" + (code ? " (" + code + ")" : "") + ". جرّب تاني.";
}

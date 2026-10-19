// الخطوة 3: الحفظ في Firestore. كل مستخدم له مساره الخاص:
//   users/{uid}/people/{id}        ← { name, phone, dueDate, createdAt }
//   users/{uid}/transactions/{id}  ← { personId, type: 'in'|'out', kind: 'debt'|'payment', amount, date, note, createdAt }
// التخزين المحلي (IndexedDB) شغال: التطبيق بيفتح من غير نت، والتعديلات بتتزامن لما النت يرجع.
import { app } from "./auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let db = null;
export function getDb() {
  if (db) return db;
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = getFirestore(app); // لو التخزين المحلي مش متاح (متصفح خاص مثلاً) نكمل من غيره
  }
  return db;
}

const col = (uid, name) => collection(getDb(), "users", uid, name);

export const newId = (uid) => doc(col(uid, "people")).id;

// handlers: { people(list, meta), txs(list, meta), error(e) }
// meta.hasPendingWrites = true لو فيه تعديلات لسه ما اتزامنتش مع السيرفر
export function subscribe(uid, handlers) {
  const toList = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const opts = { includeMetadataChanges: true };
  const u1 = onSnapshot(col(uid, "people"), opts, (s) => handlers.people(toList(s), s.metadata), handlers.error);
  const u2 = onSnapshot(col(uid, "transactions"), opts, (s) => handlers.txs(toList(s), s.metadata), handlers.error);
  return () => { u1(); u2(); };
}

const split = ({ id, ...data }) => [id, data];

export function savePerson(uid, person) {
  const [id, data] = split(person);
  return setDoc(doc(col(uid, "people"), id), data);
}

export function saveTx(uid, tx) {
  const [id, data] = split(tx);
  return setDoc(doc(col(uid, "transactions"), id), data);
}

export const removeTx = (uid, id) => deleteDoc(doc(col(uid, "transactions"), id));

// بيمسح الشخص وكل معاملاته (على دفعات، لأن Firestore بيسمح بـ 500 عملية في الدفعة)
export async function removePerson(uid, id, txIds) {
  const refs = [doc(col(uid, "people"), id), ...txIds.map((t) => doc(col(uid, "transactions"), t))];
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(getDb());
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
}

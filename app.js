// دفتر النقوط: ليا / عليا، مع حفظ في Firestore ومزامنة بين الأجهزة.
// الدخول: auth.js (Firebase Auth). الحفظ: db.js (Firestore). الباقي هنا.
import { configured, watchAuth, emailLogin, emailRegister, resetPassword, resendVerification, reloadCurrentUser, logout, errorText } from './auth.js';
import { subscribe, newId, savePerson, saveTx, removeTx, removePerson } from './db.js';
import { watchAccess, watchPayment, submitPayment, isAdminUser, refCode, IPA, PRICE } from './billing.js';

// رصيد الشخص = مجموع (ليا) − مجموع (عليا). السداد بيتسجل كمعاملة عكسية (kind = 'payment').
const state = {
  uid: null,
  unsub: null,
  people: [],            // { id, name, phone, dueDate, createdAt }
  txs: [],               // { id, personId, type: 'in'|'out', kind: 'debt'|'payment', amount, date, note, createdAt }
  loaded: { people: false, txs: false },
  pending: { people: false, txs: false },
  screen: 'screen-loading',
  currentPersonId: null,
  filter: null,          // null (الكل) | 'in' (ليا) | 'out' (عليا)
  personEdit: null,      // id الشخص اللي بيتعدل، أو null لو شخص جديد
  sheet: { txId: null, type: 'in', kind: 'debt' },
};

// ---------- أدوات صغيرة ----------
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('ar-EG', { maximumFractionDigits: 2 });
const round2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const pad = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysFromToday = (s) => Math.round((dayNum(s) - dayNum(today())) / 86400000);
const fmtDate = (s) => {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const dueText = (d) => d < 0 ? 'متأخر ' + fmt(-d) + ' يوم' : d === 0 ? 'اليوم' : d === 1 ? 'غدًا' : 'بعد ' + fmt(d) + ' يوم';
const byName = (a, b) => a.name.localeCompare(b.name, 'ar');

const signed = (t) => (t.type === 'in' ? t.amount : -t.amount);
const personById = (id) => state.people.filter((p) => p.id === id)[0];
const txLabel = (t) => t.kind === 'payment' ? (t.type === 'out' ? 'سداد منه' : 'سداد له') : (t.type === 'in' ? 'ليا' : 'عليا');

function balances() {
  const b = {};
  state.txs.forEach((t) => { b[t.personId] = round2((b[t.personId] || 0) + signed(t)); });
  return b;
}

function balCell(b) {
  if (b > 0) return '<span class="amount-in">ليا ' + fmt(b) + '</span>';
  if (b < 0) return '<span class="amount-out">عليا ' + fmt(-b) + '</span>';
  return '<span class="amount-zero">متساوي</span>';
}

// ---------- التنقل ----------
const SCREENS = ['screen-loading', 'screen-login', 'screen-verify', 'screen-locked', 'screen-home', 'screen-person'];
function show(id) {
  state.screen = id;
  SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
  window.scrollTo(0, 0);
}

function rerender() {
  if (state.screen === 'screen-home') renderHome();
  else if (state.screen === 'screen-person') renderPerson();
  updateSync();
}

// ---------- رسايل صغيرة ----------
let toastTimer;
function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

function writeError(e) {
  return e && e.code === 'permission-denied'
    ? 'تعذّر الحفظ: قواعد Firestore غير مضبوطة. راجع الدليل.'
    : 'حدثت مشكلة أثناء الحفظ. حاول مرة أخرى.';
}
const persist = (promise) => { Promise.resolve(promise).catch((e) => toast(writeError(e), true)); };

function onDataError(e) {
  const code = e && e.code;
  const el = $('data-error');
  el.textContent = code === 'permission-denied'
    ? 'غير مسموح بقراءة البيانات. تأكد من نشر قواعد Firestore (Firestore Database ← Rules ← Publish).'
    : code === 'unavailable'
      ? 'لا يوجد اتصال بقاعدة البيانات الآن. ستتم المحاولة تلقائيًا.'
      : 'حدثت مشكلة في تحميل البيانات (' + (code || 'unknown') + ').';
  el.classList.remove('hidden');
}

function updateSync() {
  let text;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) text = 'غير متصل: ستتم مزامنة التعديلات عند عودة الاتصال';
  else if (state.pending.people || state.pending.txs) text = 'جارٍ الحفظ...';
  else if (!state.loaded.people || !state.loaded.txs) text = 'جارٍ التحميل...';
  else text = '✓ متزامن';
  $('sync-line').textContent = text;
}

// ---------- الرئيسية ----------
function renderDue(bal, hide) {
  const items = hide ? [] : state.people
    .filter((p) => p.dueDate && (bal[p.id] || 0) !== 0)
    .map((p) => ({ p, d: daysFromToday(p.dueDate), b: bal[p.id] }))
    .filter((x) => x.d <= 7)
    .sort((a, b) => a.d - b.d);
  $('due-box').classList.toggle('hidden', items.length === 0);
  const ul = $('due-list');
  ul.innerHTML = '';
  items.forEach(({ p, d, b }) => {
    const li = document.createElement('li');
    li.className = 'item';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.innerHTML = '<div><div class="name"></div><div class="sub"></div></div>' +
      '<span class="due-badge ' + (d < 0 ? 'late' : d === 0 ? 'today' : 'soon') + '">' + dueText(d) + '</span>';
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.sub').textContent = (b > 0 ? 'ليا ' : 'عليا ') + fmt(Math.abs(b));
    wireRow(li, () => openPerson(p.id));
    ul.appendChild(li);
  });
}

function wireRow(li, fn) {
  li.onclick = fn;
  li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
}

function renderHome() {
  const bal = balances();
  const q = norm($('search').value).toLowerCase();

  let totalIn = 0, totalOut = 0;
  state.people.forEach((p) => {
    const b = bal[p.id] || 0;
    if (b > 0) totalIn += b; else if (b < 0) totalOut -= b;
  });
  $('sum-in').textContent = fmt(totalIn);
  $('sum-out').textContent = fmt(totalOut);

  renderDue(bal, !!q);

  let shown = state.people.filter((p) => p.name.toLowerCase().includes(q)).sort(byName);
  if (state.filter) {
    shown = shown
      .filter((p) => (state.filter === 'in' ? (bal[p.id] || 0) > 0 : (bal[p.id] || 0) < 0))
      .sort((a, b) => Math.abs(bal[b.id]) - Math.abs(bal[a.id]));
  }
  $('card-in').setAttribute('aria-pressed', state.filter === 'in');
  $('card-out').setAttribute('aria-pressed', state.filter === 'out');
  $('filter-bar').classList.toggle('hidden', !state.filter);
  if (state.filter) {
    $('filter-label').textContent =
      (state.filter === 'in' ? 'من لك عندهم' : 'من عليك لهم') + ' — ' + fmt(shown.length) + ' شخص، الأكبر مبلغاً الأول';
  }

  const list = $('people-list');
  list.innerHTML = '';
  shown.forEach((p) => {
    const b = bal[p.id] || 0;
    const li = document.createElement('li');
    li.className = 'item';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.innerHTML = '<div><div class="name"></div><div class="sub"></div></div><div>' + balCell(b) + '</div>';
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.sub').textContent =
      [p.phone, p.dueDate && b !== 0 ? 'موعد: ' + fmtDate(p.dueDate) : ''].filter(Boolean).join(' • ');
    wireRow(li, () => openPerson(p.id));
    list.appendChild(li);
  });

  const emptyEl = $('empty-people');
  if (shown.length === 0) {
    emptyEl.textContent =
      !state.loaded.people ? 'جاري تحميل دفترك...'
      : state.people.length === 0 ? 'لا يوجد أشخاص بعد. اضغط + وأضف أول شخص.'
      : state.filter === 'in' ? 'لا أحد لك عنده مال الآن.'
      : state.filter === 'out' ? 'لا أحد له عليك مال الآن.'
      : 'لا يوجد اسم بهذا الشكل.';
  }
  emptyEl.classList.toggle('hidden', shown.length > 0);
}

// ---------- صفحة الشخص ----------
function openPerson(id) {
  state.currentPersonId = id;
  renderPerson();
  show('screen-person');
}

function renderPerson() {
  const p = personById(state.currentPersonId);
  if (!p) {
    if (state.loaded.people) { state.currentPersonId = null; renderHome(); show('screen-home'); }
    return;
  }
  const bal = balances()[p.id] || 0;
  $('person-name').textContent = p.name;

  const phone = $('person-phone');
  phone.classList.toggle('hidden', !p.phone);
  phone.innerHTML = '';
  if (p.phone) {
    const a = document.createElement('a');
    a.href = 'tel:' + p.phone.replace(/[^\d+]/g, '');
    a.textContent = p.phone;
    phone.appendChild(a);
  }

  const cls = bal > 0 ? 'amount-in' : bal < 0 ? 'amount-out' : 'amount-zero';
  const label = bal > 0 ? 'لك عنده' : bal < 0 ? 'عليك له' : 'الرصيد';
  $('person-balance').innerHTML = '<div class="label">' + label + '</div><div class="value ' + cls + '">' + fmt(Math.abs(bal)) + '</div>';

  const dueEl = $('person-due');
  if (p.dueDate && bal !== 0) {
    const d = daysFromToday(p.dueDate);
    dueEl.textContent = 'موعد السداد: ' + fmtDate(p.dueDate) + ' (' + dueText(d) + ')';
    dueEl.className = 'due-line' + (d < 0 ? ' late' : '');
  } else {
    dueEl.className = 'due-line hidden';
  }


  const list = $('tx-list');
  list.innerHTML = '';
  const txs = state.txs
    .filter((t) => t.personId === p.id)
    .sort((a, b) => (a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : a.date < b.date ? 1 : -1));
  $('empty-tx').classList.toggle('hidden', txs.length > 0);
  txs.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'item';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.innerHTML = '<div><div class="name"></div><div class="sub"></div></div><div class="' + (t.type === 'in' ? 'amount-in' : 'amount-out') + '"></div>';
    li.querySelector('.name').textContent = txLabel(t);
    li.querySelector('.sub').textContent = [fmtDate(t.date), t.note].filter(Boolean).join(' • ');
    li.lastElementChild.textContent = fmt(t.amount);
    wireRow(li, () => openTxSheet({ edit: t }));
    list.appendChild(li);
  });
}

// ---------- النوافذ ----------
const openModal = (id) => $(id).classList.remove('hidden');
const closeModals = () => document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
const setMsg2 = (id, text) => { $(id).textContent = text; };

document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModals));
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) closeModals(); })
);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

// زرار حذف بخطوتين: أول ضغطة بتطلب تأكيد، التانية بتنفّذ
function resetDelete(btn, label) {
  delete btn.dataset.armed;
  btn.textContent = label;
  btn.classList.remove('armed');
}
function confirmThen(btn, label, action) {
  if (btn.dataset.armed) { action(); return; }
  btn.dataset.armed = '1';
  btn.textContent = 'تأكيد الحذف؟ اضغط مرة أخرى';
  btn.classList.add('armed');
  setTimeout(() => resetDelete(btn, label), 4000);
}

// شخص: جديد أو تعديل
function openPersonSheet(edit) {
  const p = edit ? personById(state.currentPersonId) : null;
  state.personEdit = p ? p.id : null;
  $('p-title').textContent = p ? 'تعديل بيانات الشخص' : 'شخص جديد';
  $('p-name').value = p ? p.name : '';
  $('p-phone').value = p ? p.phone || '' : '';
  $('p-due').value = p ? p.dueDate || '' : '';
  setMsg2('p-msg', '');
  $('p-delete').classList.toggle('hidden', !p);
  resetDelete($('p-delete'), 'حذف الشخص وكل معاملاته');
  openModal('modal-person');
  if (!p) $('p-name').focus();
}
$('btn-add-person').onclick = () => openPersonSheet(false);
$('btn-edit-person').onclick = () => openPersonSheet(true);

$('p-save').onclick = () => {
  const name = norm($('p-name').value);
  if (!name) return setMsg2('p-msg', 'اكتب الاسم.');
  const dup = state.people.some((p) => p.id !== state.personEdit && p.name.toLowerCase() === name.toLowerCase());
  if (dup) return setMsg2('p-msg', 'هذا الاسم موجود بالفعل. افتحه وسجّل عليه.');
  const data = { name, phone: norm($('p-phone').value), dueDate: $('p-due').value || '' };
  const old = state.personEdit ? personById(state.personEdit) : null;
  const person = old ? { ...old, ...data } : { id: newId(state.uid), ...data, createdAt: Date.now() };
  closeModals();
  persist(savePerson(state.uid, person));
};

$('p-delete').onclick = () => confirmThen($('p-delete'), 'حذف الشخص وكل معاملاته', () => {
  const id = state.personEdit;
  if (!id) return;
  const txIds = state.txs.filter((t) => t.personId === id).map((t) => t.id);
  closeModals();
  state.currentPersonId = null;
  state.personEdit = null;
  persist(removePerson(state.uid, id, txIds));
  state.people = state.people.filter((p) => p.id !== id);
  state.txs = state.txs.filter((t) => t.personId !== id);
  renderHome();
  show('screen-home');
});

// معاملة: جديدة (ليا / عليا / سداد) أو تعديل
function openTxSheet(opts) {
  const p = personById(state.currentPersonId);
  if (!p) return;
  const edit = opts.edit || null;
  state.sheet = edit
    ? { txId: edit.id, type: edit.type, kind: edit.kind || 'debt' }
    : { txId: null, type: opts.type, kind: opts.kind };
  const { type, kind } = state.sheet;
  const what = kind === 'payment'
    ? (type === 'out' ? 'سداد من ' + p.name : 'سداد لـ ' + p.name)
    : (type === 'in' ? 'ليا (هو مدين لي)' : 'عليا (أنا مدين له)');
  $('tx-title').textContent = (edit ? 'تعديل: ' : '') + what;
  $('t-amount').value = edit ? edit.amount : '';
  $('t-date').value = edit ? edit.date : today();
  $('t-note').value = edit ? edit.note || '' : '';
  $('t-due').value = '';
  $('t-due-wrap').classList.toggle('hidden', kind === 'payment' || !!edit);
  $('t-delete').classList.toggle('hidden', !edit);
  resetDelete($('t-delete'), 'حذف المعاملة');
  setMsg2('t-msg', '');
  openModal('modal-tx');
  if (!edit) $('t-amount').focus();
}
$('btn-add-in').onclick = () => openTxSheet({ type: 'in', kind: 'debt' });
$('btn-add-out').onclick = () => openTxSheet({ type: 'out', kind: 'debt' });

$('t-save').onclick = () => {
  const amount = round2(parseFloat($('t-amount').value));
  if (!(amount > 0) || amount > 1e9) return setMsg2('t-msg', 'اكتب مبلغ أكبر من صفر.');
  const p = personById(state.currentPersonId);
  if (!p) return;
  const old = state.sheet.txId ? state.txs.filter((t) => t.id === state.sheet.txId)[0] : null;
  const bal = balances()[p.id] || 0;
  const tx = {
    id: old ? old.id : newId(state.uid),
    personId: p.id,
    type: state.sheet.type,
    kind: state.sheet.kind,
    amount,
    date: $('t-date').value || today(),
    note: norm($('t-note').value),
    createdAt: old ? old.createdAt || Date.now() : Date.now(),
  };
  const newBal = round2(bal - (old ? signed(old) : 0) + signed(tx));
  const due = $('t-due').value;
  closeModals();
  persist(saveTx(state.uid, tx));
  if (tx.kind === 'debt' && due && !old) persist(savePerson(state.uid, { ...p, dueDate: due }));
  else if (newBal === 0 && p.dueDate) persist(savePerson(state.uid, { ...p, dueDate: '' })); // اتسدد كله، نمسح الموعد
};

$('t-delete').onclick = () => confirmThen($('t-delete'), 'حذف المعاملة', () => {
  const id = state.sheet.txId;
  if (!id) return;
  closeModals();
  persist(removeTx(state.uid, id));
});

// ---------- تصدير Excel ----------
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('xlsx load failed'));
    document.head.appendChild(s);
  });
}

async function exportExcel(btn) {
  btn.disabled = true;
  try {
    await loadSheetJS();
    const bal = balances();
    let totalIn = 0, totalOut = 0;
    const peopleRows = [['الاسم', 'الهاتف', 'المبلغ', 'الحالة', 'موعد السداد']];
    state.people.slice().sort(byName).forEach((p) => {
      const b = bal[p.id] || 0;
      if (b > 0) totalIn += b; else if (b < 0) totalOut -= b;
      peopleRows.push([p.name, p.phone || '', Math.abs(b), b > 0 ? 'لك عنده' : b < 0 ? 'عليك له' : 'متساوي', p.dueDate || '']);
    });
    const names = {};
    state.people.forEach((p) => { names[p.id] = p.name; });
    const txRows = [['الشخص', 'النوع', 'المبلغ', 'التاريخ', 'ملاحظة']];
    state.txs.slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)))
      .forEach((t) => txRows.push([names[t.personId] || '(محذوف)', txLabel(t), t.amount, t.date, t.note || '']));
    const summary = [['البند', 'المبلغ'], ['إجمالي ليا', totalIn], ['إجمالي عليا', totalOut], ['الصافي (ليا − عليا)', round2(totalIn - totalOut)]];

    const X = window.XLSX;
    const wb = X.utils.book_new();
    const add = (rows, name, widths) => {
      const ws = X.utils.aoa_to_sheet(rows);
      ws['!cols'] = widths.map((w) => ({ wch: w }));
      X.utils.book_append_sheet(wb, ws, name);
    };
    add(summary, 'ملخص', [24, 14]);
    add(peopleRows, 'الأشخاص', [26, 16, 12, 12, 14]);
    add(txRows, 'المعاملات', [26, 12, 12, 14, 30]);
    wb.Workbook = { Views: [{ RTL: true }] };
    X.writeFile(wb, 'naqout-' + today() + '.xlsx');
    toast('تم تجهيز ملف Excel.');
  } catch (e) {
    toast('تعذّر تجهيز ملف Excel. تأكد من الاتصال وحاول مرة أخرى.', true);
  } finally {
    btn.disabled = false;
  }
}
$('btn-export').onclick = (e) => exportExcel(e.currentTarget);

// ---------- أزرار عامة ----------
$('search').oninput = renderHome;
$('card-in').onclick = () => { state.filter = state.filter === 'in' ? null : 'in'; renderHome(); };
$('card-out').onclick = () => { state.filter = state.filter === 'out' ? null : 'out'; renderHome(); };
$('btn-clear-filter').onclick = () => { state.filter = null; renderHome(); };
$('btn-back').onclick = () => { renderHome(); show('screen-home'); };
window.addEventListener('online', updateSync);
window.addEventListener('offline', updateSync);

// ---------- المظهر (فاتح / داكن) ----------
// الافتراضي حسب إعداد الجهاز، والزرار بيثبّت اختيارك على الجهاز ده.
const themeMeta = document.querySelector('meta[name="theme-color"]');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => {
  const t = document.documentElement.getAttribute('data-theme');
  return t ? t === 'dark' : darkQuery.matches;
};
function paintTheme() {
  const dark = isDark();
  document.querySelectorAll('.theme-toggle').forEach((b) => {
    b.textContent = dark ? 'فاتح' : 'داكن';
    b.setAttribute('aria-label', dark ? 'التبديل للمظهر الفاتح' : 'التبديل للمظهر الداكن');
  });
  if (themeMeta) themeMeta.setAttribute('content', dark ? '#0e1514' : '#0f766e');
}
document.querySelectorAll('.theme-toggle').forEach((b) => {
  b.onclick = () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    paintTheme();
  };
});
darkQuery.addEventListener('change', paintTheme);
paintTheme();

// ---------- الدخول (Firebase Auth) ----------
const setMsg = (text, ok = false) => {
  const m = $('login-msg');
  m.textContent = text;
  m.className = 'msg' + (ok ? ' ok' : '');
};

async function busy(btn, fn) {
  setMsg('');
  btn.disabled = true;
  try { await fn(); } catch (e) { setMsg(errorText(e)); } finally { btn.disabled = false; }
}

const creds = () => ({ email: $('login-email').value.trim(), pass: $('login-pass').value });

// وضعان في شاشة الدخول: تسجيل الدخول، وإنشاء حساب جديد
function loginMode(register) {
  $('login-pass2').classList.toggle('hidden', !register);
  $('btn-login').classList.toggle('hidden', register);
  $('btn-register').classList.toggle('hidden', !register);
  $('btn-forgot').classList.toggle('hidden', register);
  $('btn-to-register').classList.toggle('hidden', register);
  $('btn-to-login').classList.toggle('hidden', !register);
  $('login-pass').autocomplete = register ? 'new-password' : 'current-password';
  $('login-sub').textContent = register
    ? 'أنشئ حسابًا ببريدك الإلكتروني وكلمة مرور قوية من 12 خانة على الأقل، تجمع بين الحروف والأرقام. ستصلك رسالة تأكيد على بريدك، ولا يُفتح حسابك إلا بعد تأكيدها.'
    : 'سجّل الدخول ببريدك الإلكتروني وكلمة المرور لتفتح دفترك من أي هاتف.';
  $('login-note').textContent = register
    ? 'يصلح أي بريد إلكتروني تملكه، والمهم أن تؤكده من الرسالة.'
    : 'بياناتك لا يراها غيرك، ولا يُفتح حسابك إلا بكلمة المرور.';
  $('login-pass2').value = '';
  setMsg('');
}
$('btn-to-register').onclick = () => loginMode(true);
$('btn-to-login').onclick = () => loginMode(false);

$('btn-login').onclick = (e) => busy(e.currentTarget, async () => {
  const { email, pass } = creds();
  if (!email || !pass) return setMsg('اكتب البريد الإلكتروني وكلمة المرور.');
  await emailLogin(email, pass);
});

$('btn-register').onclick = (e) => busy(e.currentTarget, async () => {
  const { email, pass } = creds();
  if (!email || !pass) return setMsg('اكتب البريد الإلكتروني وكلمة المرور لحسابك الجديد.');
  if (pass.length < 12 || !/[A-Za-z؀-ۿ]/.test(pass) || !/[0-9٠-٩]/.test(pass)) {
    return setMsg('كلمة المرور ضعيفة. اجعلها 12 خانة على الأقل، وتجمع بين الحروف والأرقام.');
  }
  if (pass !== $('login-pass2').value) return setMsg('كلمتا المرور غير متطابقتين.');
  await emailRegister(email, pass);
});

$('btn-forgot').onclick = (e) => busy(e.currentTarget, async () => {
  const { email } = creds();
  if (!email) return setMsg('اكتب البريد الإلكتروني أولًا ثم اضغط "نسيت كلمة المرور؟".');
  await resetPassword(email);
  setMsg('أرسلنا رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني. تحقق أيضًا من البريد غير الهام (Spam).', true);
});

$('btn-logout').onclick = () => logout();

if (!configured) {
  setMsg('لم تُضَف إعدادات Firebase بعد. افتح firebase-config.js والصق الإعدادات.');
  ['btn-login', 'btn-register', 'btn-forgot', 'btn-to-register'].forEach((id) => { $(id).disabled = true; });
}

// ---------- الداتا لكل مستخدم ----------
function stopData() {
  if (state.unsub) { state.unsub(); state.unsub = null; }
}
function resetData() {
  state.people = [];
  state.txs = [];
  state.loaded = { people: false, txs: false };
  state.pending = { people: false, txs: false };
  state.currentPersonId = null;
  state.filter = null;
  $('search').value = '';
  $('data-error').classList.add('hidden');
  closeModals();
  // نمسح اللي اتعرض من الشاشات، عشان مستخدم تاني على نفس الجهاز ما يشوفش داتا اللي قبله ولا لحظة
  ['people-list', 'due-list', 'tx-list', 'person-balance', 'person-phone'].forEach((id) => { $(id).innerHTML = ''; });
  $('person-name').textContent = '';
  $('sum-in').textContent = fmt(0);
  $('sum-out').textContent = fmt(0);
}
function startData(uid) {
  state.unsub = subscribe(uid, {
    people: (list, meta) => {
      state.people = list;
      state.loaded.people = true;
      state.pending.people = !!(meta && meta.hasPendingWrites);
      $('data-error').classList.add('hidden');
      rerender();
    },
    txs: (list, meta) => {
      state.txs = list;
      state.loaded.txs = true;
      state.pending.txs = !!(meta && meta.hasPendingWrites);
      rerender();
    },
    error: onDataError,
  });
}

// ---------- الاشتراك ----------
let accessUnsub = null, payUnsub = null, accessUser = null, lastAccess = { state: 'loading' }, wantPay = false;

const mins = (ms) => Math.max(1, Math.ceil(ms / 60000));
function renderPlan() {
  const line = $('plan-line');
  const a = lastAccess;
  if (a.state === 'trial') {
    $('plan-text').textContent = 'تجربة مجانية: يتبقى ' + fmt(mins(a.msLeft)) + ' دقيقة.';
    line.classList.remove('hidden');
  } else {
    line.classList.add('hidden');
  }
  $('btn-admin').classList.toggle('hidden', !isAdminUser(accessUser));
}

const PAY_TEXT = {
  pending: 'تم استلام طلبك وهو قيد المراجعة. سيُفعَّل حسابك بعد التحقق من التحويل.',
  rejected: 'لم يُقبل الطلب السابق. تأكد من بيانات التحويل وأرسل الطلب مرة أخرى.',
};
function renderPayStatus(p) {
  const el = $('pay-status');
  const st = p && p.status;
  if (st === 'pending' || st === 'rejected') {
    el.textContent = PAY_TEXT[st];
    el.className = 'pay-status' + (st === 'rejected' ? ' bad' : '');
  } else {
    el.className = 'pay-status hidden';
  }
  $('btn-pay-send').textContent = st === 'pending' ? 'تحديث بيانات الطلب' : 'أرسلت الدفع';
}

function showLocked(notice, canGoBack) {
  stopData();
  resetData();
  $('pay-price').textContent = fmt(PRICE);
  $('pay-ipa').textContent = IPA;
  $('pay-ref').textContent = accessUser ? refCode(accessUser.uid) : '';
  $('lock-notice').textContent = notice || '';
  $('btn-pay-back').classList.toggle('hidden', !canGoBack);
  $('lock-title').textContent = canGoBack ? 'اشترك في دفتر النقوط' : 'فعّل دفترك';
  $('pay-msg').textContent = '';
  show('screen-locked');
}

function onAccess(a) {
  lastAccess = a;
  if (!accessUser) return;
  if (a.state === 'trial' || a.state === 'paid') {
    renderPlan();
    if (wantPay && a.state === 'trial') { showLocked('', true); return; }
    wantPay = false;
    if (!state.unsub) { startData(accessUser.uid); }
    if (state.screen !== 'screen-home' && state.screen !== 'screen-person') { renderHome(); show('screen-home'); }
    updateSync();
  } else if (a.state === 'locked') {
    wantPay = false;
    renderPlan();
    showLocked('انتهت الفترة التجريبية أو لم يُفعَّل اشتراكك بعد. بياناتك محفوظة وستعود إليك فور التفعيل.', false);
  } else if (a.state === 'error') {
    renderPlan();
    showLocked('تعذّر التحقق من اشتراكك. تأكد من الاتصال بالإنترنت ثم أعد فتح التطبيق.', false);
  }
}

$('btn-plan-pay').onclick = () => { wantPay = true; showLocked('', true); };
$('btn-pay-back').onclick = () => { wantPay = false; onAccess(lastAccess); };
$('btn-lock-logout').onclick = () => logout();
$('btn-admin').onclick = () => { location.href = 'admin.html'; };

const copyText = async (text, btn) => {
  try { await navigator.clipboard.writeText(text); } catch (e) { /* يبقى النص قابلًا للتحديد */ }
  const old = btn.textContent; btn.textContent = 'تم النسخ'; setTimeout(() => { btn.textContent = old; }, 1500);
};
$('btn-copy-ipa').onclick = (e) => copyText(IPA, e.currentTarget);
$('btn-copy-ref').onclick = (e) => copyText($('pay-ref').textContent, e.currentTarget);

$('btn-pay-send').onclick = async (e) => {
  const name = norm($('pay-name').value), transfer = norm($('pay-transfer').value);
  const msg = $('pay-msg');
  msg.className = 'msg';
  if (!name || !transfer) { msg.textContent = 'اكتب اسم صاحب التحويل ورقم العملية أو الهاتف.'; return; }
  e.currentTarget.disabled = true;
  try {
    await submitPayment(accessUser, { name, transfer });
    msg.textContent = 'تم إرسال الطلب.';
    msg.className = 'msg ok';
  } catch (err) {
    msg.textContent = 'تعذّر إرسال الطلب. تحقق من الاتصال وحاول مرة أخرى.';
  } finally {
    e.currentTarget.disabled = false;
  }
};

// تغيير كلمة المرور: نرسل رابط تأكيد إلى بريد المستخدم، ولا تتغير الكلمة إلا بعد فتحه واختيار كلمة جديدة
document.querySelectorAll('.js-change-pass').forEach((b) => {
  b.onclick = async () => {
    if (!accessUser || !accessUser.email) return;
    b.disabled = true;
    try {
      await resetPassword(accessUser.email);
      toast('أرسلنا رابط التأكيد إلى ' + accessUser.email + '. لن تتغير كلمة المرور قبل فتحه.');
    } catch (e) {
      toast(errorText(e), true);
    } finally {
      b.disabled = false;
    }
  };
});

// ---------- تأكيد البريد الإلكتروني ----------
const vmsg = (t, ok) => { const m = $('verify-msg'); m.textContent = t; m.className = 'msg' + (ok ? ' ok' : ''); };
$('btn-resend').onclick = async (e) => {
  e.currentTarget.disabled = true;
  try { await resendVerification(); vmsg('أعدنا إرسال رسالة التأكيد. تحقق من البريد والبريد غير الهام.', true); }
  catch (err) { vmsg(errorText(err)); }
  finally { e.currentTarget.disabled = false; }
};
$('btn-verified').onclick = async (e) => {
  e.currentTarget.disabled = true;
  try {
    const u = await reloadCurrentUser();
    if (u && u.emailVerified) enter(u);
    else vmsg('لم يتم التأكيد بعد. افتح الرابط في رسالة البريد ثم حاول مرة أخرى.');
  } catch (err) { vmsg(errorText(err)); }
  finally { e.currentTarget.disabled = false; }
};
$('btn-verify-logout').onclick = () => logout();

function enter(user) {
  if (accessUnsub) { accessUnsub(); accessUnsub = null; }
  if (payUnsub) { payUnsub(); payUnsub = null; }
  stopData();
  resetData();
  wantPay = false;
  lastAccess = { state: 'loading' };
  if (user) {
    state.uid = user.uid;
    accessUser = user;
    $('user-email').textContent = user.email || user.displayName || '';
    $('login-pass').value = '';
    $('pay-name').value = '';
    $('pay-transfer').value = '';
    setMsg('');
    if (!user.emailVerified) {
      // لا يُفتح الدفتر ولا تبدأ التجربة قبل تأكيد ملكية البريد
      $('verify-email').textContent = user.email || '';
      vmsg('');
      show('screen-verify');
      return;
    }
    if (isAdminUser(user)) { // حساب المدير للإدارة فقط: لا دفتر ولا اشتراك
      show('screen-loading');
      location.replace('admin.html');
      return;
    }
    show('screen-loading');
    payUnsub = watchPayment(user.uid, renderPayStatus);
    accessUnsub = watchAccess(user, onAccess);
  } else {
    state.uid = null;
    accessUser = null;
    loginMode(false);
    show('screen-login');
  }
}
watchAuth(enter);

// تثبيت التطبيق وفتحه من غير نت
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

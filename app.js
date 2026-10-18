// دفتر النقوط: ليا / عليا، مع حفظ في Firestore ومزامنة بين الأجهزة.
// الدخول: auth.js (Firebase Auth). الحفظ: db.js (Firestore). الباقي هنا.
import { configured, watchAuth, googleLogin, emailLogin, emailRegister, resetPassword, logout, errorText } from './auth.js';
import { subscribe, newId, savePerson, saveTx, removeTx, removePerson } from './db.js';

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
const dueText = (d) => d < 0 ? 'متأخر ' + fmt(-d) + ' يوم' : d === 0 ? 'النهاردة' : d === 1 ? 'بكرة' : 'بعد ' + fmt(d) + ' يوم';
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
const SCREENS = ['screen-loading', 'screen-login', 'screen-home', 'screen-person'];
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
    ? 'مش قادر يحفظ: قواعد Firestore مش متظبطة. راجع الدليل.'
    : 'حصلت مشكلة في الحفظ. جرّب تاني.';
}
const persist = (promise) => { Promise.resolve(promise).catch((e) => toast(writeError(e), true)); };

function onDataError(e) {
  const code = e && e.code;
  const el = $('data-error');
  el.textContent = code === 'permission-denied'
    ? 'مش مسموح بقراءة الداتا. اتأكد إن قواعد Firestore اتنشرت (Firestore Database ← Rules ← Publish).'
    : code === 'unavailable'
      ? 'مفيش اتصال بقاعدة البيانات دلوقتي. هيحاول تاني لوحده.'
      : 'حصلت مشكلة في تحميل الداتا (' + (code || 'unknown') + ').';
  el.classList.remove('hidden');
}

function updateSync() {
  let text;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) text = 'أوفلاين: التعديلات هتتزامن لما النت يرجع';
  else if (state.pending.people || state.pending.txs) text = 'بيتحفظ...';
  else if (!state.loaded.people || !state.loaded.txs) text = 'بيحمّل...';
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
      (state.filter === 'in' ? 'اللي ليك عندهم' : 'اللي عليك ليهم') + ' — ' + fmt(shown.length) + ' شخص، الأكبر مبلغاً الأول';
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
      : state.people.length === 0 ? 'مفيش أشخاص لسه. اضغط + وضيف أول شخص.'
      : state.filter === 'in' ? 'مفيش حد ليك عنده فلوس دلوقتي.'
      : state.filter === 'out' ? 'مفيش حد عليك له فلوس دلوقتي.'
      : 'مفيش اسم بالشكل ده.';
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
  const label = bal > 0 ? 'ليا عنده' : bal < 0 ? 'عليا ليه' : 'الرصيد';
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
  btn.textContent = 'تأكيد الحذف؟ دوس تاني';
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
  if (dup) return setMsg2('p-msg', 'الاسم ده موجود بالفعل. افتحه وسجّل عليه.');
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
    : (type === 'in' ? 'ليا (هو مديون لي)' : 'عليا (أنا مديون له)');
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
    const peopleRows = [['الاسم', 'التليفون', 'المبلغ', 'الحالة', 'موعد السداد']];
    state.people.slice().sort(byName).forEach((p) => {
      const b = bal[p.id] || 0;
      if (b > 0) totalIn += b; else if (b < 0) totalOut -= b;
      peopleRows.push([p.name, p.phone || '', Math.abs(b), b > 0 ? 'ليا عنده' : b < 0 ? 'عليا ليه' : 'متساوي', p.dueDate || '']);
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
    toast('معرفتش أجهّز ملف Excel. اتأكد من النت وجرّب تاني.', true);
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

$('btn-google').onclick = (e) => busy(e.currentTarget, googleLogin);

$('btn-login').onclick = (e) => busy(e.currentTarget, async () => {
  const { email, pass } = creds();
  if (!email || !pass) return setMsg('اكتب الإيميل وكلمة السر.');
  await emailLogin(email, pass);
});

$('btn-register').onclick = (e) => busy(e.currentTarget, async () => {
  const { email, pass } = creds();
  if (!email || !pass) return setMsg('اكتب الإيميل وكلمة السر اللي عايزها لحسابك الجديد.');
  await emailRegister(email, pass);
});

$('btn-forgot').onclick = (e) => busy(e.currentTarget, async () => {
  const { email } = creds();
  if (!email) return setMsg('اكتب الإيميل الأول وبعدين اضغط "نسيت كلمة السر؟".');
  await resetPassword(email);
  setMsg('بعتنالك رابط إعادة تعيين كلمة السر على الإيميل. شوف كمان في Spam.', true);
});

$('btn-logout').onclick = () => logout();

if (!configured) {
  setMsg('لسه ماضفتش إعدادات Firebase. افتح firebase-config.js والصق الإعدادات.');
  ['btn-google', 'btn-login', 'btn-register', 'btn-forgot'].forEach((id) => { $(id).disabled = true; });
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

watchAuth((user) => {
  stopData();
  resetData();
  if (user) {
    state.uid = user.uid;
    $('user-email').textContent = user.email || user.displayName || '';
    $('login-pass').value = '';
    setMsg('');
    startData(user.uid);
    renderHome();
    updateSync();
    show('screen-home');
  } else {
    state.uid = null;
    show('screen-login');
  }
});

// تثبيت التطبيق وفتحه من غير نت
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

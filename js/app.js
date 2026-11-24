import { db, uid } from './db.js';
import { UNITS, SERVING, compatibleUnits, unitLabel, nutritionFor, sumNutrition, dateKey, shiftDate } from './units.js';
import { scanLabel } from './scanner.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Math.round((Number(n) || 0) * 10) / 10).toString();

const state = {
  view: 'today',
  date: dateKey(),
  foods: [],
};

// ---------- settings (tiny, so localStorage is fine) ----------
const settings = {
  get() {
    try { return JSON.parse(localStorage.getItem('ssct-settings')) || {}; } catch { return {}; }
  },
  set(patch) {
    const next = { ...settings.get(), ...patch };
    try { localStorage.setItem('ssct-settings', JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  },
};

// ---------- helpers ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function prettyDate(key) {
  const today = dateKey();
  if (key === today) return 'Today';
  if (key === shiftDate(today, -1)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

function servingText(food) {
  return `${fmt(food.servingAmount)} ${unitLabel(food.servingUnit)}`;
}

function macroLine(n) {
  return `P ${fmt(n.protein)}g · C ${fmt(n.carbs)}g · F ${fmt(n.fat)}g`;
}

function fillUnitSelect(select, units, selected) {
  select.innerHTML = units
    .map((u) => `<option value="${u}" ${u === selected ? 'selected' : ''}>${esc(unitLabel(u))}</option>`)
    .join('');
}

async function loadFoods() {
  state.foods = await db.allFoods();
  state.foods.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name));
}

// ---------- navigation ----------
function showView(view) {
  state.view = view;
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== `view-${view}`;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === view);
  $('#datenav').hidden = view !== 'today';
  $('#fab').hidden = view !== 'today';
  $('#title').textContent = { today: '', foods: 'My Foods', history: 'History', settings: 'Settings' }[view];
  render();
}

function render() {
  if (state.view === 'today') return renderDay();
  if (state.view === 'foods') return renderFoods();
  if (state.view === 'history') return renderHistory();
  if (state.view === 'settings') return renderSettings();
}

// ---------- today ----------
async function renderDay() {
  const today = dateKey();
  $('#dateLabel').textContent = prettyDate(state.date);
  $('#nextDay').disabled = state.date >= today;

  const entries = (await db.entriesOn(state.date)).sort((a, b) => a.createdAt - b.createdAt);
  const total = sumNutrition(entries);
  const { goal, proteinGoal } = settings.get();

  $('#sumCalories').textContent = total.calories;
  $('#sumGoal').textContent = goal ? `of ${goal} kcal` : 'kcal';
  const left = goal ? goal - total.calories : null;
  $('#sumRemaining').innerHTML = goal
    ? `<b>${Math.abs(left)}</b><span>${left >= 0 ? 'left' : 'over'}</span>`
    : '';
  $('#sumRemaining').classList.toggle('over', left !== null && left < 0);
  const bar = $('#sumBar');
  bar.style.width = goal ? `${Math.min(100, (total.calories / goal) * 100)}%` : '0%';
  bar.classList.toggle('over', left !== null && left < 0);
  $('#sumProtein').textContent = fmt(total.protein) + (proteinGoal ? `/${proteinGoal}` : '');
  $('#sumCarbs').textContent = fmt(total.carbs);
  $('#sumFat').textContent = fmt(total.fat);

  $('#emptyDay').hidden = entries.length > 0;
  $('#entryList').innerHTML = entries
    .map((e) => `
      <li data-id="${e.id}">
        <div class="grow">
          <div class="name">${esc(e.name)}</div>
          <div class="muted small">${fmt(e.amount)} ${esc(unitLabel(e.unit))}${e.unit === SERVING && e.amount !== 1 ? 's' : ''} · ${macroLine(e)}</div>
        </div>
        <div class="kcal">${e.calories}<small>kcal</small></div>
      </li>`)
    .join('');
}

// ---------- foods ----------
function foodItem(f) {
  return `
    <li data-id="${f.id}">
      <div class="grow">
        <div class="name">${esc(f.name)}</div>
        <div class="muted small">${esc(servingText(f))} · ${macroLine(f)}</div>
      </div>
      <div class="kcal">${Math.round(f.calories)}<small>kcal</small></div>
    </li>`;
}

function filterFoods(q) {
  q = q.trim().toLowerCase();
  return q ? state.foods.filter((f) => f.name.toLowerCase().includes(q)) : state.foods;
}

async function renderFoods() {
  await loadFoods();
  const list = filterFoods($('#foodSearch').value);
  $('#foodList').innerHTML = list.map(foodItem).join('');
  $('#emptyFoods').hidden = state.foods.length > 0;
}

// ---------- history ----------
async function renderHistory() {
  const entries = await db.allEntries();
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  const days = [...byDay.keys()].sort().reverse();
  const { goal } = settings.get();

  $('#emptyHistory').hidden = days.length > 0;
  $('#historyList').innerHTML = days
    .map((d) => {
      const t = sumNutrition(byDay.get(d));
      const pct = goal ? Math.min(100, (t.calories / goal) * 100) : 0;
      const over = goal && t.calories > goal;
      return `
        <li data-date="${d}">
          <div class="grow">
            <div class="name">${esc(prettyDate(d))}</div>
            <div class="muted small">${macroLine(t)} · ${byDay.get(d).length} items</div>
            ${goal ? `<div class="bar thin"><div class="${over ? 'over' : ''}" style="width:${pct}%"></div></div>` : ''}
          </div>
          <div class="kcal">${t.calories}<small>kcal</small></div>
        </li>`;
    })
    .join('');

  // Averages over logged days in the last 7 / 30 days.
  const today = dateKey();
  const avg = (n) => {
    const from = shiftDate(today, -(n - 1));
    const ds = days.filter((d) => d >= from && d <= today);
    if (!ds.length) return null;
    const totals = ds.map((d) => sumNutrition(byDay.get(d)));
    return {
      days: ds.length,
      calories: Math.round(totals.reduce((a, t) => a + t.calories, 0) / ds.length),
      protein: Math.round(totals.reduce((a, t) => a + t.protein, 0) / ds.length),
    };
  };
  const a7 = avg(7);
  const a30 = avg(30);
  $('#averages').hidden = !a7 && !a30;
  $('#averages').innerHTML = `
    <div class="avg-row">
      <div><small>7-day avg</small><b>${a7 ? a7.calories : '–'}</b><span class="muted small">${a7 ? `kcal · ${a7.protein}g protein` : ''}</span></div>
      <div><small>30-day avg</small><b>${a30 ? a30.calories : '–'}</b><span class="muted small">${a30 ? `kcal · ${a30.protein}g protein` : ''}</span></div>
    </div>
    <p class="muted small">Averages only count days you logged something.</p>`;
}

// ---------- settings ----------
function renderSettings() {
  const s = settings.get();
  $('#goalInput').value = s.goal || '';
  $('#proteinGoalInput').value = s.proteinGoal || '';
}

// ---------- add sheet ----------
function openAddSheet() {
  $('#addSearch').value = '';
  renderAddList();
  $('#addDialog').showModal();
}

async function renderAddList() {
  await loadFoods();
  const list = filterFoods($('#addSearch').value);
  $('#addList').innerHTML = list.map(foodItem).join('');
  $('#addEmpty').hidden = state.foods.length > 0;
}

// ---------- food editor ----------
// mode: 'new' (save to My Foods), 'edit' (existing food), 'log' (custom/scanned food → then pick a portion)
let foodCtx = null;

function syncDefaultUnits(preferred) {
  const form = $('#foodForm');
  const units = compatibleUnits(form.servingUnit.value);
  const current = preferred ?? form.defaultUnit.value;
  const chosen = units.includes(current) ? current : SERVING;
  if (chosen !== current && !preferred) form.defaultAmount.value = 1;
  fillUnitSelect(form.defaultUnit, units, chosen);
}

function openFoodEditor(mode, food = null) {
  foodCtx = { mode, food };
  const form = $('#foodForm');
  form.reset();
  const f = food || { name: '', servingAmount: 1, servingUnit: 'piece', calories: '', protein: '', carbs: '', fat: '', defaultAmount: 1, defaultUnit: SERVING };
  form.name.value = f.name;
  form.servingAmount.value = f.servingAmount;
  fillUnitSelect(form.servingUnit, Object.keys(UNITS), f.servingUnit);
  for (const k of ['calories', 'protein', 'carbs', 'fat']) form[k].value = f[k] === '' ? '' : fmt(f[k]);
  form.defaultAmount.value = f.defaultAmount;
  syncDefaultUnits(f.defaultUnit);

  $('#foodDialogTitle').textContent = { new: 'New food', edit: 'Edit food', log: 'Custom food' }[mode];
  $('#foodSubmitBtn').textContent = mode === 'log' ? 'Next →' : 'Save';
  $('#deleteFoodBtn').hidden = mode !== 'edit';
  $('#saveFavRow').hidden = mode !== 'log';
  form.saveFav.checked = true;
  $('#scanStatus').hidden = true;
  $('#foodDialog').showModal();
}

function readFoodForm() {
  const form = $('#foodForm');
  const num = (k) => (form[k].value === '' ? 0 : Number(form[k].value));
  return {
    name: form.name.value.trim(),
    servingAmount: num('servingAmount'),
    servingUnit: form.servingUnit.value,
    calories: num('calories'),
    protein: num('protein'),
    carbs: num('carbs'),
    fat: num('fat'),
    defaultAmount: num('defaultAmount'),
    defaultUnit: form.defaultUnit.value,
  };
}

async function submitFood() {
  const data = readFoodForm();
  if (!data.name) return toast('Give it a name');
  if (!(data.servingAmount > 0)) return toast('Serving size must be more than 0');

  const { mode, food } = foodCtx;
  let saved;
  if (mode === 'edit') {
    saved = await db.putFood({ ...food, ...data });
  } else if (mode === 'new' || $('#foodForm').saveFav.checked) {
    saved = await db.putFood({ id: uid(), createdAt: Date.now(), ...data });
  }
  $('#foodDialog').close();

  if (mode === 'log') {
    openPortion({ food: saved || { id: null, ...data } });
  } else {
    toast('Saved');
    render();
  }
}

// ---------- label scanning ----------
// Applies a scan result to the open food editor.
async function handleScan(file) {
  const status = $('#scanStatus');
  status.hidden = false;
  status.textContent = 'Reading label… (first scan downloads the reader, ~10 MB)';
  try {
    const r = await scanLabel(file, (p) => { status.textContent = `Reading label… ${Math.round(p * 100)}%`; });
    const form = $('#foodForm');
    const found = [];
    if (r.servingAmount) {
      form.servingAmount.value = Math.round(r.servingAmount * 1000) / 1000;
      fillUnitSelect(form.servingUnit, Object.keys(UNITS), r.servingUnit || 'piece');
      form.defaultAmount.value = 1;
      syncDefaultUnits(SERVING);
      found.push('serving');
    }
    for (const k of ['calories', 'protein', 'carbs', 'fat']) {
      if (r[k] != null) { form[k].value = fmt(r[k]); found.push(k); }
    }
    const missing = ['serving', 'calories', 'protein', 'carbs', 'fat'].filter((k) => !found.includes(k));
    status.textContent = found.length
      ? `Found ${found.join(', ')}.${missing.length ? ` Couldn't read ${missing.join(', ')} — please fill in.` : ''} Double-check the numbers.`
      : "Couldn't read that label. Try again with the label flat, well lit and filling the frame.";
    if (!form.name.value) form.name.focus();
  } catch (err) {
    console.error(err);
    status.textContent = `Scan failed: ${err.message}`;
  }
}

function startScan(mode) {
  // Must run inside the click handler so the browser allows opening the camera.
  openFoodEditor(mode);
  $('#cameraInput').value = '';
  $('#cameraInput').click();
}

// ---------- portion calculator ----------
// ctx: { food } to add a new entry, or { entry } to edit an existing one.
let portionCtx = null;

function openPortion(ctx) {
  portionCtx = ctx;
  const form = $('#portionForm');
  const food = ctx.entry ? ctx.entry.food : ctx.food;
  $('#portionTitle').textContent = ctx.entry ? ctx.entry.name : food.name;
  $('#portionServing').textContent = `1 serving = ${servingText(food)} · ${Math.round(food.calories)} kcal`;
  const amount = ctx.entry ? ctx.entry.amount : food.defaultAmount || 1;
  const unit = ctx.entry ? ctx.entry.unit : food.defaultUnit || SERVING;
  const units = compatibleUnits(food.servingUnit);
  form.amount.value = fmt(amount);
  fillUnitSelect(form.unit, units, units.includes(unit) ? unit : SERVING);
  $('#portionChips').innerHTML = [0.5, 1, 1.5, 2]
    .map((n) => `<button type="button" data-servings="${n}">${n === 0.5 ? '½' : n} serving${n > 1 ? 's' : ''}</button>`)
    .join('');
  const day = prettyDate(state.date);
  $('#portionSubmitBtn').textContent = ctx.entry ? 'Update' : day === 'Today' ? 'Add' : `Add to ${day}`;
  $('#deleteEntryBtn').hidden = !ctx.entry;
  updatePortionPreview();
  $('#portionDialog').showModal();
}

function portionNutrition() {
  const form = $('#portionForm');
  const food = portionCtx.entry ? portionCtx.entry.food : portionCtx.food;
  return nutritionFor(food, form.amount.value || 0, form.unit.value);
}

function updatePortionPreview() {
  const n = portionNutrition();
  $('#pvCalories').textContent = n.calories;
  $('#pvProtein').textContent = `${fmt(n.protein)}g`;
  $('#pvCarbs').textContent = `${fmt(n.carbs)}g`;
  $('#pvFat').textContent = `${fmt(n.fat)}g`;
}

async function submitPortion() {
  const form = $('#portionForm');
  const amount = Number(form.amount.value);
  if (!(amount > 0)) return toast('Enter an amount');
  const unit = form.unit.value;
  const n = portionNutrition();

  if (portionCtx.entry) {
    await db.putEntry({ ...portionCtx.entry, amount, unit, ...n });
  } else {
    const f = portionCtx.food;
    await db.putEntry({
      id: uid(),
      date: state.date,
      createdAt: Date.now(),
      foodId: f.id || null,
      name: f.name,
      amount,
      unit,
      // Snapshot of the food so editing/deleting it later never changes history.
      food: { name: f.name, servingAmount: f.servingAmount, servingUnit: f.servingUnit, calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat },
      ...n,
    });
    if (f.id) await db.putFood({ ...f, lastUsed: Date.now() });
  }
  $('#portionDialog').close();
  toast(portionCtx.entry ? 'Updated' : `Added ${n.calories} kcal`);
  if (state.view !== 'today') showView('today'); else render();
}

// ---------- wiring ----------
function wire() {
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showView(b.dataset.view));
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
  // Tap the backdrop to close a sheet.
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }

  $('#prevDay').addEventListener('click', () => { state.date = shiftDate(state.date, -1); render(); });
  $('#nextDay').addEventListener('click', () => { state.date = shiftDate(state.date, 1); render(); });
  $('#dateLabel').addEventListener('click', () => { state.date = dateKey(); render(); });
  $('#fab').addEventListener('click', openAddSheet);

  $('#entryList').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const entry = (await db.entriesOn(state.date)).find((x) => x.id === li.dataset.id);
    if (entry) openPortion({ entry });
  });

  // Add sheet
  $('#addSearch').addEventListener('input', renderAddList);
  $('#addList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    const food = li && state.foods.find((f) => f.id === li.dataset.id);
    if (!food) return;
    $('#addDialog').close();
    openPortion({ food });
  });
  $('#quickAddBtn').addEventListener('click', () => { $('#addDialog').close(); openFoodEditor('log'); });
  $('#scanAddBtn').addEventListener('click', () => { $('#addDialog').close(); startScan('log'); });

  // Foods tab
  $('#newFoodBtn').addEventListener('click', () => openFoodEditor('new'));
  $('#scanFoodBtn').addEventListener('click', () => startScan('new'));
  $('#foodSearch').addEventListener('input', renderFoods);
  $('#foodList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    const food = li && state.foods.find((f) => f.id === li.dataset.id);
    if (food) openFoodEditor('edit', food);
  });

  // Food editor
  const foodForm = $('#foodForm');
  foodForm.servingUnit.addEventListener('change', () => syncDefaultUnits());
  foodForm.addEventListener('submit', (e) => { e.preventDefault(); submitFood(); });
  $('#deleteFoodBtn').addEventListener('click', async () => {
    if (!confirm(`Delete "${foodCtx.food.name}" from My Foods? Days you already logged stay the same.`)) return;
    await db.deleteFood(foodCtx.food.id);
    $('#foodDialog').close();
    toast('Deleted');
    render();
  });
  $('#scanIntoFormBtn').addEventListener('click', () => { $('#cameraInput').value = ''; $('#cameraInput').click(); });
  $('#cameraInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleScan(file);
  });

  // Portion calculator
  const pf = $('#portionForm');
  pf.amount.addEventListener('input', updatePortionPreview);
  pf.unit.addEventListener('change', updatePortionPreview);
  pf.addEventListener('submit', (e) => { e.preventDefault(); submitPortion(); });
  $('#portionChips').addEventListener('click', (e) => {
    const n = e.target.dataset?.servings;
    if (!n) return;
    pf.amount.value = n;
    pf.unit.value = SERVING;
    updatePortionPreview();
  });
  $('#deleteEntryBtn').addEventListener('click', async () => {
    await db.deleteEntry(portionCtx.entry.id);
    $('#portionDialog').close();
    toast('Removed');
    render();
  });

  // History → jump to that day
  $('#historyList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-date]');
    if (!li) return;
    state.date = li.dataset.date;
    showView('today');
  });

  // Settings
  $('#goalInput').addEventListener('change', (e) => settings.set({ goal: Number(e.target.value) || 0 }));
  $('#proteinGoalInput').addEventListener('change', (e) => settings.set({ proteinGoal: Number(e.target.value) || 0 }));
  $('#exportBtn').addEventListener('click', async () => {
    const data = { ...(await db.exportAll()), settings: settings.get() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `calorie-tracker-backup-${dateKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await db.importAll(data);
      if (data.settings) settings.set(data.settings);
      toast(`Imported ${data.foods.length} foods, ${data.entries.length} entries`);
      render();
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
    e.target.value = '';
  });

  // If the app stays open past midnight, roll "today" forward.
  let lastToday = dateKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = dateKey();
    if (now !== lastToday) {
      if (state.date === lastToday) state.date = now;
      lastToday = now;
      render();
    }
  });
}

wire();
showView('today');

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

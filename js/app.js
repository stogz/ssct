import { db, uid, settings } from './db.js';
import { firebaseConfig } from './firebase-config.js';
import {
  UNITS, KIND_LABELS, SERVING, compatibleUnits, convertible, servingMeasures, unitLabel, formatAmount,
  nutritionFor, sumNutrition, dateKey, shiftDate,
} from './units.js';
import { PRESETS, MACROS, goalsFromCalories, customGoals, macroSplit, normalizeGoals } from './goals.js';
import { FOOD_EMOJI_GROUPS, sanitizeEmoji, emojiName } from './food-emojis.js';
import { scanLabel } from './scanner.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Math.round((Number(n) || 0) * 10) / 10).toString();
const round3 = (n) => Math.round(n * 1000) / 1000;

const state = {
  view: 'today',
  date: dateKey(),
  foods: [],
};

// ---------- settings ----------
const getGoals = () => normalizeGoals(settings.get());
// Also drops the first version's goal/proteinGoal keys (JSON.stringify skips undefined).
const saveGoals = (goals) => settings.set({ goals, goal: undefined, proteinGoal: undefined });

// Ask the browser not to delete our data when the device runs low on space.
// Asked after the first save rather than on load, because Firefox shows a prompt for it.
let persistAsked = false;
function protectStorage() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  navigator.storage.persisted().then((ok) => ok || navigator.storage.persist()).catch(() => {});
}

// ---------- appearance: Light / Dark / Automatic ----------
// Saved on this device only (not synced, kept on sign-out). index.html applies it before the page draws.
const THEME_KEY = 'ssct-theme';

function setTheme(theme) {
  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* private mode: still applies until the page closes */ }
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  renderTheme();
}

function renderTheme() {
  const theme = document.documentElement.dataset.theme || 'auto';
  for (const b of document.querySelectorAll('#themeOptions button')) {
    const on = b.dataset.themeOption === theme;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

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

const amountText = (amount, unit) => `${formatAmount(amount, unit)} ${unitLabel(unit, amount)}`;

// "2 tbsp (32 g)"
function servingText(food) {
  const [first, second] = servingMeasures(food).map(([a, u]) => amountText(a, u));
  return second ? `${first} (${second})` : first || '';
}

function macroLine(n) {
  return `P ${fmt(n.protein)}g · C ${fmt(n.carbs)}g · F ${fmt(n.fat)}g`;
}

// Unit <select> with options grouped into Weight / Volume / Count.
function fillUnitSelect(select, units, selected, blank) {
  const opt = (u) => `<option value="${u}"${u === selected ? ' selected' : ''}>${esc(unitLabel(u))}</option>`;
  const groups = new Map();
  for (const u of units) {
    const kind = u === SERVING ? '' : UNITS[u].kind;
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(u);
  }
  select.innerHTML = (blank ? `<option value="">${esc(blank)}</option>` : '')
    + [...groups].map(([kind, us]) => (kind
      ? `<optgroup label="${KIND_LABELS[kind]}">${us.map(opt).join('')}</optgroup>`
      : us.map(opt).join(''))).join('');
}

// The food's emoji, or its first letter, in a fixed-size square so lists line up.
function avatar(name, emoji) {
  if (emoji) return `<span class="avatar" aria-hidden="true">${esc(emoji)}</span>`;
  const first = Array.from(String(name || '?').trim())[0] || '?';
  return `<span class="avatar letter" aria-hidden="true">${esc(first.toUpperCase())}</span>`;
}

// Entries show the saved food's current icon, so adding an icon later updates old entries too.
function entryEmoji(entry) {
  const food = state.foods.find((f) => f.id === entry.foodId);
  return food ? food.emoji || '' : entry.emoji || '';
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
  if (state.view === 'settings') {
    renderGoals();
    renderAccount();
    renderTheme();
  }
}

// ---------- account & cloud sync (only when Firebase is set up) ----------
// `?emulator` on localhost uses the Firebase emulators, for testing.
const useEmulator = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('emulator');
let cloud = null; // { signIn, signUp, resetPassword, signOut } once js/sync.js has loaded
let cloudState = { configured: Boolean(firebaseConfig || useEmulator), ready: false, user: null, status: 'signedOut', pending: 0, error: '' };

let remoteRenderTimer = null;
function renderSoon() {
  clearTimeout(remoteRenderTimer);
  remoteRenderTimer = setTimeout(render, 150);
}

let cloudStarting = false;
async function startCloud() {
  if (!cloudState.configured || cloudStarting) return;
  cloudStarting = true;
  const failed = (err, message) => {
    console.error(err);
    cloudState = { ...cloudState, ready: true, status: 'error', error: message };
    renderAccount();
  };
  let syncModule;
  try {
    syncModule = await import('./sync.js');
  } catch (err) {
    cloudStarting = false; // e.g. first launch while offline: try again when back online
    return failed(err, "Couldn't load sign-in. Check your connection.");
  }
  try {
    cloud = syncModule.startSync({
      emulator: useEmulator,
      onState: (s) => {
        cloudState = { ...cloudState, ...s };
        renderAccount();
      },
      onRemoteChange: renderSoon,
    });
  } catch (err) {
    failed(err, `Sync is set up wrong: ${err.message}`);
  }
}

function syncStatusText(s) {
  const changes = `${s.pending} change${s.pending === 1 ? '' : 's'}`;
  if (s.status === 'synced') return '✓ Everything is backed up to your account.';
  if (s.status === 'syncing') return s.pending ? `Backing up ${changes}…` : 'Syncing…';
  if (s.status === 'offline') return `You're offline. ${changes} will back up when you're back online.`;
  if (s.status === 'error') return `Couldn't back up: ${s.error} Trying again shortly.`;
  return '';
}

function renderAccount() {
  const s = cloudState;
  $('#accountCard').hidden = !s.configured;
  const signedIn = Boolean(s.user);
  $('#accountLoading').hidden = !s.configured || s.ready;
  $('#authForm').hidden = !s.ready || signedIn;
  $('#accountInfo').hidden = !signedIn;
  if (signedIn) {
    $('#accountEmail').textContent = s.user.email;
    $('#syncStatus').textContent = syncStatusText(s);
    $('#syncStatus').dataset.status = s.status;
  }
  $('#dataNote').textContent = signedIn
    ? 'Backed up to your account, so clearing this browser or losing your phone won\'t lose it. You can also export a copy.'
    : `Saved on this device only${s.configured ? ' until you sign in' : ''}. Clearing this site's data in your browser, or deleting the app, erases it, so export a backup now and then.`;
}

function authMessage(text, isError = true) {
  const el = $('#authMessage');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = !text;
}

// ---------- today ----------
// Progress meter toward a goal; hidden when there's no goal.
function setMeter(el, value, goal) {
  el.hidden = !(goal > 0);
  if (el.hidden) return;
  const pct = Math.min(100, (value / goal) * 100);
  el.classList.toggle('over', value > goal);
  el.setAttribute('aria-valuenow', Math.round(value));
  el.setAttribute('aria-valuemax', Math.round(goal));
  // Two frames later, so the bar animates from where it was (or from empty when it just appeared).
  requestAnimationFrame(() => requestAnimationFrame(() => { el.firstElementChild.style.width = `${pct}%`; }));
}

let dayRenderId = 0;
async function renderDay() {
  const renderId = ++dayRenderId;
  $('#dateLabel').textContent = prettyDate(state.date);
  $('#nextDay').disabled = state.date >= dateKey();

  const [entries] = await Promise.all([db.entriesOn(state.date), loadFoods()]);
  if (renderId !== dayRenderId) return; // a newer render (e.g. fast day switching) took over
  entries.sort((a, b) => a.createdAt - b.createdAt);
  const total = sumNutrition(entries);
  const goals = getGoals();

  $('#sumCalories').textContent = total.calories;
  setMeter($('#meter-calories'), total.calories, goals.calories);
  for (const m of MACROS) {
    $(`#sum-${m}`).textContent = `${fmt(total[m])}g`;
    setMeter($(`#meter-${m}`), total[m], goals[m]);
  }
  $('#setGoalsHint').hidden = goals.calories > 0;

  $('#emptyDay').hidden = entries.length > 0;
  $('#entryList').innerHTML = entries
    .map((e) => `
      <li data-id="${e.id}">
        ${avatar(e.name, entryEmoji(e))}
        <div class="grow">
          <div class="name">${esc(e.name)}</div>
          <div class="muted small">${esc(amountText(e.amount, e.unit))} · ${macroLine(e)}</div>
        </div>
        <div class="kcal">${e.calories}<small>kcal</small></div>
      </li>`)
    .join('');
}

// ---------- foods ----------
function foodItem(f) {
  return `
    <li data-id="${f.id}">
      ${avatar(f.name, f.emoji)}
      <div class="grow">
        <div class="name">${esc(f.name)}</div>
        <div class="muted small">${esc(servingText(f))} · ${macroLine(f)}</div>
      </div>
      <div class="kcal">${Math.round(f.calories)}<small>kcal</small></div>
    </li>`;
}

// Matches the food's name, its icon's name ("apple" finds foods marked 🍎), or the icon itself.
function filterFoods(q) {
  q = q.trim().toLowerCase();
  if (!q) return state.foods;
  const asEmoji = sanitizeEmoji(q);
  return state.foods.filter((f) => f.name.toLowerCase().includes(q)
    || (f.emoji && (f.emoji === asEmoji || emojiName(f.emoji).includes(q))));
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
  const goal = getGoals().calories;

  $('#emptyHistory').hidden = days.length > 0;
  $('#historyList').innerHTML = days
    .map((d) => {
      const t = sumNutrition(byDay.get(d));
      const pct = goal ? Math.min(100, (t.calories / goal) * 100) : 0;
      return `
        <li data-date="${d}">
          <div class="grow">
            <div class="name">${esc(prettyDate(d))}</div>
            <div class="muted small">${macroLine(t)} · ${byDay.get(d).length} items</div>
            ${goal ? `<div class="meter cal thin${t.calories > goal ? ' over' : ''}"><div style="width:${pct}%"></div></div>` : ''}
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

// ---------- settings: daily goals ----------
function buildGoalModes() {
  const split = (p) => `<span class="split">${MACROS.map((m) => `<i class="${m}" style="width:${p[m]}%"></i>`).join('')}</span>`;
  $('#goalModes').innerHTML = Object.entries(PRESETS)
    .map(([key, p]) => `
      <button type="button" data-mode="${key}">
        <b>${esc(p.label)}</b>
        <small>${MACROS.map((m) => `<span>${m[0].toUpperCase()} ${p[m]}%</span>`).join(' · ')}</small>
        ${split(p)}
      </button>`)
    .join('') + `
      <button type="button" data-mode="custom">
        <b>Custom</b>
        <small>Set the grams yourself</small>
      </button>`;
}

// `typing` is the input being edited, which keeps the user's raw text (e.g. "67.").
function renderGoals(typing) {
  const g = getGoals();
  const custom = g.mode === 'custom';
  for (const b of document.querySelectorAll('#goalModes button')) {
    const on = b.dataset.mode === g.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const cal = $('#goalCalories');
  cal.readOnly = custom;
  if (cal !== typing) cal.value = g.calories || '';
  for (const m of MACROS) {
    const input = $(`#goal-${m}`);
    input.readOnly = !custom;
    if (input !== typing) input.value = g[m] ? fmt(g[m]) : '';
  }
  const split = macroSplit(g);
  $('#goalHint').textContent = custom
    ? `Calories are worked out from your grams: protein and carbs are 4 kcal per gram, fat is 9.${split ? ` That's ${split.protein}% protein, ${split.carbs}% carbs and ${split.fat}% fat.` : ''}`
    : 'Enter your daily calories and the grams are worked out for you.';
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
// mode: 'new' (save to My Foods), 'edit' (existing food), 'log' (custom/scanned food, then pick a portion)
let foodCtx = null;

function buildEmojiGrid() {
  $('#emojiGrid').innerHTML = `
    <div class="emoji-head"><span>Pick an icon</span><button type="button" class="link" data-emoji=""><span class="icon icon-none" aria-hidden="true"></span>No icon</button></div>
    ${FOOD_EMOJI_GROUPS.map((g) => `
      <div class="emoji-group">${esc(g.label)}</div>
      ${g.items.map(([e, name]) => `<button type="button" class="cell" data-emoji="${e}" title="${esc(name)}" aria-label="${esc(name)}">${e}</button>`).join('')}`).join('')}`;
}

function setEmoji(value) {
  const emoji = sanitizeEmoji(value);
  $('#foodForm').emoji.value = emoji;
  const btn = $('#emojiBtn');
  btn.textContent = emoji || '+';
  btn.classList.toggle('empty', !emoji);
  btn.setAttribute('aria-label', emoji ? `Icon: ${emojiName(emoji)}. Tap to change` : 'Choose an icon');
  for (const c of document.querySelectorAll('#emojiGrid .cell')) c.classList.toggle('active', c.dataset.emoji === emoji);
}

function toggleEmojiGrid(open) {
  const grid = $('#emojiGrid');
  grid.hidden = !open;
  $('#emojiBtn').setAttribute('aria-expanded', String(open));
}

// The serving measures as currently typed in the form.
function formServing() {
  const form = $('#foodForm');
  return {
    servingAmount: Number(form.servingAmount.value) || 0,
    servingUnit: form.servingUnit.value,
    servingAmount2: Number(form.servingAmount2.value) || 0,
    servingUnit2: form.servingUnit2.value,
  };
}

// The second measure must be a different kind than the first (weight vs volume vs count).
function syncSecondUnits(preferred) {
  const form = $('#foodForm');
  const units = Object.keys(UNITS).filter((u) => !convertible(u, form.servingUnit.value));
  const current = preferred ?? form.servingUnit2.value;
  fillUnitSelect(form.servingUnit2, units, units.includes(current) ? current : '', '—');
}

function syncDefaultUnits(preferred) {
  const form = $('#foodForm');
  const units = compatibleUnits(formServing());
  const current = preferred ?? form.defaultUnit.value;
  const chosen = units.includes(current) ? current : SERVING;
  if (chosen !== current && preferred === undefined) form.defaultAmount.value = 1;
  fillUnitSelect(form.defaultUnit, units, chosen);
}

function openFoodEditor(mode, food = null) {
  foodCtx = { mode, food };
  const form = $('#foodForm');
  form.reset();
  const f = food || {
    name: '', emoji: '', servingAmount: 1, servingUnit: 'piece', servingAmount2: null, servingUnit2: null,
    calories: '', protein: '', carbs: '', fat: '', defaultAmount: 1, defaultUnit: SERVING,
  };
  form.name.value = f.name;
  setEmoji(f.emoji);
  toggleEmojiGrid(false);
  form.servingAmount.value = f.servingAmount;
  fillUnitSelect(form.servingUnit, Object.keys(UNITS), f.servingUnit);
  form.servingAmount2.value = f.servingAmount2 || '';
  syncSecondUnits(f.servingUnit2 || '');
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
  const amount2 = num('servingAmount2');
  const unit2 = form.servingUnit2.value;
  const hasSecond = amount2 > 0 && UNITS[unit2] && !convertible(unit2, form.servingUnit.value);
  return {
    name: form.name.value.trim(),
    emoji: sanitizeEmoji(form.emoji.value),
    servingAmount: num('servingAmount'),
    servingUnit: form.servingUnit.value,
    servingAmount2: hasSecond ? amount2 : null,
    servingUnit2: hasSecond ? unit2 : null,
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
  if (saved) protectStorage();
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
      form.servingAmount.value = round3(r.servingAmount);
      fillUnitSelect(form.servingUnit, Object.keys(UNITS), r.servingUnit || 'piece');
      form.servingAmount2.value = r.servingAmount2 ? round3(r.servingAmount2) : '';
      syncSecondUnits(r.servingUnit2 || '');
      form.defaultAmount.value = 1;
      syncDefaultUnits(SERVING);
      found.push('serving size');
    }
    for (const k of ['calories', 'protein', 'carbs', 'fat']) {
      if (r[k] != null) { form[k].value = fmt(r[k]); found.push(k); }
    }
    const missing = ['serving size', 'calories', 'protein', 'carbs', 'fat'].filter((k) => !found.includes(k));
    status.textContent = found.length
      ? `Found ${found.join(', ')}.${missing.length ? ` Couldn't read ${missing.join(', ')}, please fill in.` : ''} Double-check the numbers.`
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
  const emoji = ctx.entry ? entryEmoji(ctx.entry) : food.emoji;
  $('#portionTitle').textContent = `${emoji ? `${emoji} ` : ''}${ctx.entry ? ctx.entry.name : food.name}`;
  $('#portionServing').textContent = `1 serving = ${servingText(food)} · ${Math.round(food.calories)} kcal`;
  const amount = ctx.entry ? ctx.entry.amount : food.defaultAmount || 1;
  const unit = ctx.entry ? ctx.entry.unit : food.defaultUnit || SERVING;
  const units = compatibleUnits(food);
  form.amount.value = fmt(amount);
  fillUnitSelect(form.unit, units, units.includes(unit) ? unit : SERVING);
  $('#portionChips').innerHTML = [0.5, 1, 1.5, 2]
    .map((n) => `<button type="button" data-servings="${n}">${amountText(n, SERVING)}</button>`)
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
      emoji: f.emoji || '',
      amount,
      unit,
      // Snapshot of the food so editing/deleting it later never changes history.
      food: {
        name: f.name,
        servingAmount: f.servingAmount,
        servingUnit: f.servingUnit,
        servingAmount2: f.servingAmount2 ?? null,
        servingUnit2: f.servingUnit2 ?? null,
        calories: f.calories,
        protein: f.protein,
        carbs: f.carbs,
        fat: f.fat,
      },
      ...n,
    });
    if (f.id) await db.putFood({ ...f, lastUsed: Date.now() });
  }
  protectStorage();
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
  $('#setGoalsHint').addEventListener('click', () => showView('settings'));

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
  foodForm.servingUnit.addEventListener('change', () => { syncSecondUnits(); syncDefaultUnits(); });
  foodForm.servingUnit2.addEventListener('change', () => syncDefaultUnits());
  foodForm.servingAmount2.addEventListener('input', () => syncDefaultUnits());
  foodForm.addEventListener('submit', (e) => { e.preventDefault(); submitFood(); });
  $('#emojiBtn').addEventListener('click', () => toggleEmojiGrid($('#emojiGrid').hidden));
  $('#emojiGrid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-emoji]');
    if (!b) return;
    setEmoji(b.dataset.emoji);
    toggleEmojiGrid(false);
  });
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

  // Settings: appearance
  $('#themeOptions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme-option]');
    if (b) setTheme(b.dataset.themeOption);
  });

  // Settings: goals
  $('#goalModes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    const g = getGoals();
    // Switching keeps what you had: grams carry over into Custom, calories carry over into a preset.
    saveGoals(b.dataset.mode === 'custom' ? customGoals(g) : goalsFromCalories(g.calories, b.dataset.mode));
    renderGoals();
  });
  $('#goalCalories').addEventListener('input', (e) => {
    const g = getGoals();
    if (g.mode === 'custom') return;
    saveGoals(goalsFromCalories(e.target.value, g.mode));
    renderGoals(e.target);
  });
  for (const m of MACROS) {
    $(`#goal-${m}`).addEventListener('input', (e) => {
      const g = getGoals();
      if (g.mode !== 'custom') return;
      saveGoals(customGoals({ ...g, [m]: e.target.value }));
      renderGoals(e.target);
    });
  }

  // Settings: account
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!cloud) return authMessage("Sign-in isn't available right now. Check your connection.");
    const form = e.target;
    const signUp = e.submitter?.value === 'signup';
    authMessage('');
    form.classList.add('busy');
    try {
      if (signUp) await cloud.signUp(form.email.value.trim(), form.password.value);
      else await cloud.signIn(form.email.value.trim(), form.password.value);
      form.reset();
      toast(signUp ? 'Account created' : 'Signed in');
    } catch (err) {
      authMessage(err.message);
    } finally {
      form.classList.remove('busy');
    }
  });
  $('#forgotBtn').addEventListener('click', async () => {
    const email = $('#authForm').email.value.trim();
    if (!email) return authMessage('Enter your email above, then tap "Forgot password?" again.');
    if (!cloud) return authMessage("Sign-in isn't available right now. Check your connection.");
    try {
      await cloud.resetPassword(email);
      authMessage(`If there's an account for ${email}, a link to reset the password is on its way.`, false);
    } catch (err) {
      authMessage(err.message);
    }
  });
  $('#signOutBtn').addEventListener('click', async () => {
    const { pending } = cloudState;
    const question = pending
      ? `${pending} change${pending === 1 ? " hasn't" : "s haven't"} been backed up yet and will be lost. Sign out anyway?`
      : "Sign out? Your data stays safe in your account. This device's copy is removed until you sign in again.";
    if (!confirm(question)) return;
    try {
      await cloud.signOut();
      toast('Signed out');
    } catch (err) {
      toast(err.message);
    }
  });

  // Settings: backup
  $('#exportBtn').addEventListener('click', async () => {
    const data = { ...(await db.exportAll()), settings: { goals: getGoals() } };
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
      // Only food emojis, even from a hand-edited backup.
      if (Array.isArray(data.foods)) data.foods.forEach((f) => { f.emoji = sanitizeEmoji(f.emoji); });
      if (Array.isArray(data.entries)) data.entries.forEach((x) => { x.emoji = sanitizeEmoji(x.emoji); });
      await db.importAll(data);
      if (data.settings) saveGoals(normalizeGoals(data.settings));
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

buildGoalModes();
buildEmojiGrid();
wire();
showView('today');
startCloud();
// If sign-in couldn't load (e.g. first launch while offline), try again once back online.
window.addEventListener('online', startCloud);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

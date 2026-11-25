import { db, uid, settings } from './db.js';
import { firebaseConfig } from './firebase-config.js';
import {
  UNITS, KIND_LABELS, SERVING, compatibleUnits, convertible, servingMeasures, unitLabel, formatAmount,
  nutritionFor, sumNutrition, dateKey, shiftDate,
} from './units.js';
import { PRESETS, MACROS, EXTRAS, goalsFromCalories, customGoals, macroSplit, normalizeGoals, normalizeExtras } from './goals.js';
import {
  ACTIVITY, kgToLb, lbToKg, cmFromFeetInches, feetInchesFromCm, daysBetween, addDays,
  trendAt, bodyFatAt, maintenance, normalizeGoal, goalRecord, goalStart, goalProgress, weightTolerance,
  BODY_FAT_TOLERANCE, weightAtBodyFat, calorieTarget, suggestedExtras,
} from './plan.js';
import { FOOD_EMOJI_GROUPS, sanitizeEmoji, emojiName } from './food-emojis.js';
import { ACCENTS, ACCENT_VARS, accentVars, parseHex } from './colors.js';
import { scanLabel } from './scanner.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Math.round((Number(n) || 0) * 10) / 10).toString();
const round3 = (n) => Math.round(n * 1000) / 1000;
const kcal = (n) => Math.round(n).toLocaleString();

const state = {
  view: 'today',
  date: dateKey(),
  historyOpen: false, // Today's calendar button shows history in place of the day
  foods: [],
  weights: [], // oldest first
  chartRange: null, // 'goal' | '30' | '90' | 'all'; null picks a sensible default
  chartMetric: null, // 'weight' | 'bodyFat'; null follows your goal
  goalMetric: null, // the kind of goal the goal form shows; null follows your goal
};

// ---------- settings ----------
// Also drops the first version's goal/proteinGoal keys (JSON.stringify skips undefined).
const saveGoals = (goals) => settings.set({ goals, goal: undefined, proteinGoal: undefined });
const getProfile = () => settings.get().profile || {};
// Sodium, sugar and fiber: whether each shows on Today, and the goal you typed (null = the suggested amount).
// Synced with the other goals.
const getExtras = () => normalizeExtras(settings.get());
const saveExtra = (key, patch) => {
  const extras = getExtras();
  settings.set({ extras: { ...extras, [key]: { ...extras[key], ...patch } } });
};
// "1,850mg" / "18g"
const extraText = (key, value) => {
  const x = EXTRAS.find((e) => e.key === key);
  return x.unit === 'mg' ? `${kcal(value)}mg` : `${fmt(value)}g`;
};
const saveProfile = (patch) => settings.set({ profile: { ...getProfile(), ...patch } });

// ---------- body weight & height units ----------
// Pounds and feet by default in the US (and Liberia and Myanmar), metric elsewhere.
const defaultUnits = () => (/-(US|LR|MM)$/i.test(navigator.language || '') ? 'imperial' : 'metric');
const imperial = () => (getProfile().units || defaultUnits()) === 'imperial';
const weightUnit = () => (imperial() ? 'lb' : 'kg');
const toWeightUnit = (kg) => (imperial() ? kgToLb(kg) : kg);
const fromWeightUnit = (v) => (imperial() ? lbToKg(v) : v);
const weightText = (kg) => `${toWeightUnit(kg).toFixed(1)} ${weightUnit()}`;
// "−2.1 lb", "+0.4%"; no sign on a change that rounds to zero
const changeText = (value, unit) => {
  const text = Math.abs(value).toFixed(1);
  return `${Number(text) ? (value < 0 ? '−' : '+') : ''}${text}${unit}`;
};
const weightChange = (kg) => changeText(toWeightUnit(kg), ` ${weightUnit()}`);
const bodyFatChange = (pct) => changeText(pct, '%');
// "1.2 lb a week (0.17 lb a day)" from a rate in kg per day
const rateText = (kgPerDay) => {
  const u = weightUnit();
  return `${Math.abs(toWeightUnit(kgPerDay * 7)).toFixed(1)} ${u} a week (${Math.abs(toWeightUnit(kgPerDay)).toFixed(2)} ${u} a day)`;
};
// "0.5% a week (0.07% a day)" from a body fat rate in % per day
const bodyFatRateText = (perDay) => `${Math.abs(perDay * 7).toFixed(1)}% a week (${Math.abs(perDay).toFixed(2)}% a day)`;
// A goal amount: "185.0 lb" or "18%"
const goalValueText = (metric, v) => (metric === 'bodyFat' ? `${fmt(v)}%` : weightText(v));

async function loadWeights() {
  state.weights = await db.allWeights();
}

// Everything the goals depend on, worked out from today's numbers:
//  trend: your 7-day average weight (and recent body fat); bodyFat: your 7-day average body fat
//  goal: your weight or body fat goal, starting from your average on its start date; progress: how it's going
//  target: the calories that keep you on course
function currentPlan() {
  const s = settings.get();
  const today = dateKey();
  const profile = s.profile || {};
  const trend = trendAt(state.weights, today);
  const bodyFat = bodyFatAt(state.weights, today);
  const maint = trend ? maintenance(profile, trend.kg, trend.bodyFat) : null;
  const saved = normalizeGoal(s.weightGoal); // weight or body fat; the setting's name is from before body fat goals
  const goal = saved && { ...saved, start: goalStart(saved, state.weights) };
  let progress = null;
  let perWeekKg = 0; // the weight change the calories aim for
  if (goal?.metric === 'weight' && trend) {
    progress = goalProgress(goal, trend.kg, today, weightTolerance(trend.kg));
    // Aim for the pace that still finishes on time, so being behind or ahead adjusts the calories.
    perWeekKg = progress.neededPerDay * 7;
  } else if (goal?.metric === 'bodyFat' && trend && bodyFat) {
    progress = goalProgress(goal, bodyFat.pct, today, BODY_FAT_TOLERANCE);
    // Calories aim for what you'd weigh at the goal body fat, keeping the lean mass you have now.
    progress.leanKg = trend.kg * (1 - bodyFat.pct / 100);
    progress.goalKg = weightAtBodyFat(trend.kg, bodyFat.pct, goal.target);
    perWeekKg = progress.daysLeft > 0 ? ((progress.goalKg - trend.kg) / progress.daysLeft) * 7 : 0;
  }
  const goalActive = Boolean(progress) && !['reached', 'overdue'].includes(progress.status);
  const target = maint ? calorieTarget(maint.calories, goalActive ? perWeekKg : 0, profile.sex) : null;
  return { today, profile, trend, bodyFat, maint, goal, progress, goalActive, target };
}

// Sodium, sugar and fiber worked out for you: from your plan's calories (height, weight, age, sex and activity),
// or your daily calorie goal until About you is filled in. `basis` says which, for the explanation.
function extraSuggestions(plan = currentPlan()) {
  const goalCalories = getGoals().calories;
  const calories = plan.target?.calories || goalCalories || null;
  const basis = plan.target ? 'plan' : goalCalories ? 'goal' : 'none';
  return { values: suggestedExtras({ calories, age: plan.profile.age, sex: plan.profile.sex }), calories, basis };
}

// The goal each extra is measured against: what you typed, or the suggested amount.
function extraGoals() {
  const extras = getExtras();
  const suggested = extraSuggestions().values;
  return Object.fromEntries(EXTRAS.map((x) => [x.key, extras[x.key].target ?? suggested[x.key]]));
}

// Daily nutrition goals. "From my plan" makes the calories follow the plan; the preset splits them into grams.
function getGoals() {
  const s = settings.get();
  const g = normalizeGoals(s);
  const fromPlan = Boolean(s.goals?.auto) && g.mode !== 'custom';
  if (fromPlan) {
    const { target } = currentPlan();
    if (target) return { ...goalsFromCalories(target.calories, g.mode), fromPlan };
  }
  return { ...g, fromPlan };
}

// Ask the browser not to delete our data when the device runs low on space.
// Asked after the first save rather than on load, because Firefox shows a prompt for it.
let persistAsked = false;
function protectStorage() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  navigator.storage.persisted().then((ok) => ok || navigator.storage.persist()).catch(() => {});
}

// ---------- appearance: theme and accent color ----------
// Saved on this device only (not synced, kept on sign-out). index.html applies both before the page draws.
// Defaults: Light, green.
const THEME_KEY = 'ssct-theme'; // 'light' | 'dark' | 'auto'
const ACCENT_KEY = 'ssct-accent'; // { key, hex, vars } for anything but green

function setTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode: still applies until the page closes */ }
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  renderTheme();
}

function getAccent() {
  try { return JSON.parse(localStorage.getItem(ACCENT_KEY)) || { key: 'green', hex: ACCENTS[0].light }; } catch { return { key: 'green', hex: ACCENTS[0].light }; }
}

// choice: a preset key, or 'custom' with a hex color.
function setAccent(key, hex) {
  const preset = ACCENTS.find((a) => a.key === key);
  if (!preset && !parseHex(hex)) return;
  const vars = preset ? accentVars(preset.light, preset.dark, preset.chartDark) : accentVars(hex.toLowerCase());
  try {
    if (key === 'green') localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, JSON.stringify({ key: preset ? key : 'custom', hex: preset ? preset.light : hex, vars }));
  } catch { /* private mode */ }
  const root = document.documentElement.style;
  for (const name of ACCENT_VARS) {
    if (key === 'green') root.removeProperty(`--${name}`);
    else root.setProperty(`--${name}`, vars[name]);
  }
  $('meta[name=theme-color]').content = vars['accent-l'];
  renderTheme();
  if (state.view === 'goals') renderChart(currentPlan()); // the chart reads the line color when drawn
}

function buildAccentSwatches() {
  $('#accentSwatches').innerHTML = ACCENTS
    .map((a) => `<button type="button" class="swatch" data-accent="${a.key}" style="--swatch:${a.light}" aria-label="${esc(a.label)}"></button>`)
    .join('') + `
    <label class="swatch custom" aria-label="Custom color"><input type="color" id="accentCustom" value="#16a34a"></label>`;
}

function renderTheme() {
  const theme = document.documentElement.dataset.theme || 'auto';
  for (const b of document.querySelectorAll('#themeOptions button')) {
    const on = b.dataset.themeOption === theme;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const accent = getAccent();
  for (const b of document.querySelectorAll('#accentSwatches [data-accent]')) {
    const on = b.dataset.accent === accent.key;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const custom = $('#accentSwatches .custom');
  custom.classList.toggle('active', accent.key === 'custom');
  if (accent.key === 'custom') {
    custom.style.setProperty('--swatch', accent.hex);
    if (document.activeElement !== $('#accentCustom')) $('#accentCustom').value = accent.hex;
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
const TITLES = { today: '', foods: 'My Foods', goals: 'Goals', settings: 'Settings' };

// History isn't a tab: the calendar button on Today swaps the day for the history list.
function showView(view) {
  if (view === 'goals' && state.view !== 'goals') state.goalMetric = null; // the goal form opens on your goal's kind
  state.view = view;
  const history = view === 'today' && state.historyOpen;
  const shown = history ? 'history' : view;
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== `view-${shown}`;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === view);
  $('#datenav').hidden = view !== 'today';
  $('#datenav').classList.toggle('history', history);
  $('#dateLabel').disabled = history;
  const historyBtn = $('#historyBtn');
  historyBtn.hidden = view !== 'today';
  historyBtn.classList.toggle('active', history);
  historyBtn.setAttribute('aria-pressed', String(history));
  historyBtn.setAttribute('aria-label', history ? 'Close history' : 'History');
  $('#fab').hidden = view !== 'today' || history;
  $('#title').textContent = TITLES[view];
  render();
}

function render() {
  if (state.view === 'today') return state.historyOpen ? renderHistory() : renderDay();
  if (state.view === 'foods') return renderFoods();
  if (state.view === 'goals') return renderGoalsPage();
  if (state.view === 'settings') {
    renderAccount();
    renderDashboardSwitches();
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

  const [entries] = await Promise.all([db.entriesOn(state.date), loadFoods(), loadWeights()]);
  if (renderId !== dayRenderId) return; // a newer render (e.g. fast day switching) took over
  entries.sort((a, b) => a.createdAt - b.createdAt);
  const weight = state.weights.find((w) => w.date === state.date);
  const total = sumNutrition(entries);
  const goals = getGoals();

  $('#sumCalories').textContent = total.calories;
  setMeter($('#meter-calories'), total.calories, goals.calories);
  for (const m of MACROS) {
    $(`#sum-${m}`).textContent = `${fmt(total[m])}g`;
    setMeter($(`#meter-${m}`), total[m], goals[m]);
  }
  const extras = getExtras();
  const extraGoal = extraGoals();
  const shown = EXTRAS.filter((x) => extras[x.key].show);
  $('#extrasRow').hidden = shown.length === 0;
  for (const x of EXTRAS) {
    const on = extras[x.key].show;
    $(`#extra-${x.key}`).hidden = !on;
    if (!on) continue;
    $(`#sum-${x.key}`).textContent = extraText(x.key, total[x.key]);
    setMeter($(`#meter-${x.key}`), total[x.key], extraGoal[x.key]);
  }
  $('#setGoalsHint').hidden = goals.calories > 0;

  $('#emptyDay').hidden = entries.length > 0 || Boolean(weight);
  $('#entryList').innerHTML = (weight ? weightRow(weight) : '') + entries
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

// The day's weigh-in, shown above the food entries.
function weightRow(w) {
  return `
    <li class="weight-row" data-weight="${w.date}">
      <span class="avatar" aria-hidden="true"><span class="icon icon-scale"></span></span>
      <div class="grow">
        <div class="name">Weight</div>
        <div class="muted small">${w.bodyFat ? `${fmt(w.bodyFat)}% body fat` : 'Weigh-in'}</div>
      </div>
      <div class="kcal">${toWeightUnit(w.kg).toFixed(1)}<small>${weightUnit()}</small></div>
    </li>`;
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

// Most-logged first (counted from your entries), then most recently used, then by name.
async function loadFoodsByUse() {
  const [foods, entries] = await Promise.all([db.allFoods(), db.allEntries()]);
  const uses = new Map();
  for (const e of entries) if (e.foodId) uses.set(e.foodId, (uses.get(e.foodId) || 0) + 1);
  foods.sort((a, b) => (uses.get(b.id) || 0) - (uses.get(a.id) || 0)
    || (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name));
  state.foods = foods;
}

async function renderFoods() {
  await loadFoodsByUse();
  const list = filterFoods($('#foodSearch').value);
  $('#foodList').innerHTML = list.map(foodItem).join('');
  $('#emptyFoods').hidden = state.foods.length > 0;
}

// ---------- history ----------
async function renderHistory() {
  $('#dateLabel').textContent = 'History';
  const [entries] = await Promise.all([db.allEntries(), loadWeights()]);
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  const weightOn = new Map(state.weights.map((w) => [w.date, w]));
  const days = [...new Set([...byDay.keys(), ...weightOn.keys()])].sort().reverse();
  const goal = getGoals().calories;

  $('#emptyHistory').hidden = days.length > 0;
  $('#historyList').innerHTML = days
    .map((d) => {
      const dayEntries = byDay.get(d) || [];
      const t = sumNutrition(dayEntries);
      const w = weightOn.get(d);
      const food = dayEntries.length ? macroLine(t) : 'No food logged';
      return `
        <li data-date="${d}">
          <div class="grow">
            <div class="name">${esc(prettyDate(d))}</div>
            <div class="muted small">${food}${w ? ` · ${esc(weightText(w.kg))}` : ''}</div>
            ${dayEntries.length ? macroBar(t, goal) : ''}
          </div>
          <div class="kcal">${t.calories}<small>kcal</small></div>
        </li>`;
    })
    .join('');
}

// One bar split into protein, carbs and fat by the calories each gave. With a calorie goal,
// the bar's length is the day's share of the goal (full at or over it).
function macroBar(t, goal) {
  const from = { protein: t.protein * 4, carbs: t.carbs * 4, fat: t.fat * 9 };
  const total = MACROS.reduce((sum, m) => sum + from[m], 0);
  if (!total) return '';
  const width = goal ? Math.min(100, (t.calories / goal) * 100) : 100;
  const pct = (m) => Math.round((from[m] / total) * 100);
  const label = `${kcal(t.calories)} kcal${goal ? ` of ${kcal(goal)}` : ''}: ${pct('protein')}% protein, ${pct('carbs')}% carbs, ${pct('fat')}% fat`;
  const parts = MACROS.filter((m) => from[m] > 0).map((m) => `<i class="${m}" style="flex-grow:${from[m].toFixed(1)}"></i>`).join('');
  return `<div class="macro-bar${goal ? ' has-goal' : ''}" role="img" aria-label="${esc(label)}"><div class="fill" style="width:${width.toFixed(1)}%">${parts}</div></div>`;
}

// ---------- goals page ----------
async function renderGoalsPage() {
  await loadWeights();
  const plan = currentPlan();
  renderProgress(plan);
  renderGoalForm(plan);
  renderGoals();
  renderProfile(plan);
}

function renderExtraGoals() {
  const extras = getExtras();
  const suggestion = extraSuggestions();
  for (const x of EXTRAS) {
    const input = $(`#goal-${x.key}`);
    input.placeholder = String(suggestion.values[x.key]);
    if (input !== document.activeElement) input.value = extras[x.key].target ?? '';
  }
  $('#extrasBasis').textContent = extrasBasisText(suggestion);
  const shown = EXTRAS.filter((x) => extras[x.key].show).map((x) => x.label.toLowerCase());
  $('#extrasShownNote').textContent = shown.length
    ? `Showing ${listText(shown)} on Today.`
    : 'Turn them on in Settings to see them on Today.';
}

// How the suggested amounts were worked out.
function extrasBasisText({ values, calories, basis }) {
  const sodium = `Sodium stays under ${kcal(values.sodium)} mg: health guidelines use one limit for everyone 14 and older, whatever their size.`;
  if (basis === 'none') {
    return `Leave a box blank to use a suggested amount. Fill in About you and log your weight to base fiber and sugar on your height, weight and age. ${sodium}`;
  }
  const from = basis === 'plan'
    ? `your ${kcal(calories)} kcal plan (your height, weight, age, sex and activity)`
    : `your ${kcal(calories)} kcal daily goal (fill in About you to base it on your height, weight and age)`;
  return `Leave a box blank to use the amount worked out for you from ${from}: fiber is 14 g per 1,000 kcal and sugar under 10% of calories. ${sodium}`;
}

function renderDashboardSwitches() {
  const extras = getExtras();
  for (const input of document.querySelectorAll('[data-extra-toggle]')) input.checked = extras[input.dataset.extraToggle].show;
}

function shortDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

const listText = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');

// Status chips always pair a mark and words with the color.
const STATUS = {
  'on-track': { text: 'On track', tone: 'good', mark: '✓' },
  ahead: { text: 'Ahead of plan', tone: 'good', mark: '✓' },
  behind: { text: 'Behind plan', tone: 'warn', mark: '!' },
  reached: { text: 'Goal reached', tone: 'good', mark: '✓' },
  overdue: { text: 'Date passed', tone: 'warn', mark: '!' },
};

function chartRange(plan) {
  const range = state.chartRange || (plan.goal ? 'goal' : '90');
  return range === 'goal' && !plan.goal ? '90' : range;
}

// Which measure the chart shows: what you picked, else your goal's, else weight.
const chartMetric = (plan) => state.chartMetric || plan.goal?.metric || 'weight';

function renderProgress(plan) {
  const metric = chartMetric(plan);
  const range = chartRange(plan);
  for (const b of document.querySelectorAll('#chartRange button')) {
    b.hidden = b.dataset.range === 'goal' && !plan.goal;
    b.classList.toggle('active', b.dataset.range === range);
    b.setAttribute('aria-pressed', String(b.dataset.range === range));
  }
  for (const b of document.querySelectorAll('#chartMetric button')) {
    const on = b.dataset.metric === metric;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  // The goal's numbers show with the measure it's for.
  const g = plan.goal?.metric === metric ? plan.goal : null;
  if (metric === 'weight') {
    $('#progressLabel').textContent = 'Weight, 7-day average';
    $('#progressValue').textContent = plan.trend ? toWeightUnit(plan.trend.kg).toFixed(1) : '–';
    $('#progressUnit').textContent = plan.trend ? weightUnit() : '';
    $('#progressSub').textContent = plan.trend && g
      ? `${weightChange(plan.trend.kg - g.start)} since ${shortDate(g.startDate)} · goal ${weightText(g.target)} by ${shortDate(g.targetDate)}`
      : plan.trend ? `Last weigh-in ${shortDate(plan.trend.lastDate)}` : '';
  } else {
    const bf = plan.bodyFat;
    $('#progressLabel').textContent = 'Body fat, 7-day average';
    $('#progressValue').textContent = bf ? fmt(bf.pct) : '–';
    $('#progressUnit').textContent = bf ? '%' : '';
    $('#progressSub').textContent = bf && g
      ? `${bodyFatChange(bf.pct - g.start)} since ${shortDate(g.startDate)} · goal ${fmt(g.target)}% by ${shortDate(g.targetDate)}`
      : bf ? `Last reading ${shortDate(bf.lastDate)}` : '';
  }
  const status = $('#progressStatus');
  const p = g && plan.progress;
  status.hidden = !p;
  if (p) {
    const s = STATUS[p.status];
    const off = metric === 'weight' ? `${Math.abs(toWeightUnit(p.diff)).toFixed(1)} ${weightUnit()}` : `${Math.abs(p.diff).toFixed(1)}%`;
    status.textContent = `${s.mark} ${s.text}${['behind', 'ahead'].includes(p.status) ? ` by ${off}` : ''}`;
    status.dataset.tone = s.tone;
  }
  renderChart(plan);
}

// ----- weight chart (inline SVG) -----
// What to plot for the chosen measure and time range, in display units.
function chartData(plan) {
  const metric = chartMetric(plan);
  const weightMode = metric === 'weight';
  const today = dateKey();
  const series = weightMode
    ? state.weights.map((w) => ({ date: w.date, value: toWeightUnit(w.kg) }))
    : state.weights.filter((w) => w.bodyFat > 0).map((w) => ({ date: w.date, value: w.bodyFat }));
  const { goal } = plan;
  const range = chartRange(plan);
  const last = series.length ? series[series.length - 1].date : today;
  let end = last > today ? last : today;
  let start;
  if (range === 'goal') {
    // From the goal's start (with up to two weeks of weigh-ins before it, for context) to its date.
    const lead = series.find((p) => p.date >= addDays(goal.startDate, -14));
    start = lead && lead.date < goal.startDate ? lead.date : goal.startDate;
    if (goal.targetDate > end) end = goal.targetDate;
  } else if (range === 'all') {
    start = series.length ? series[0].date : addDays(end, -29);
  } else {
    start = addDays(end, 1 - Number(range));
  }
  if (daysBetween(start, end) < 6) start = addDays(end, -6); // at least a week wide
  const points = series.filter((p) => p.date >= start && p.date <= end);
  // Dots are the readings, the line their 7-day average (what goals are measured with).
  const line = points.map((p) => ({
    date: p.date,
    value: weightMode ? toWeightUnit(trendAt(state.weights, p.date).kg) : bodyFatAt(state.weights, p.date).pct,
  }));
  const inUnit = (v) => (weightMode ? toWeightUnit(v) : v);
  const planLine = goal?.metric === metric
    ? [{ date: goal.startDate, value: inUnit(goal.start) }, { date: goal.targetDate, value: inUnit(goal.target) }]
    : null;
  return { weightMode, start, end, today, points, line, planLine, unit: weightMode ? weightUnit() : '%' };
}

// Round gridline values covering lo..hi.
function niceTicks(lo, hi, count = 4) {
  const raw = (hi - lo) / count || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 1000; v += step) {
    ticks.push(Math.round(v * 1000) / 1000);
  }
  return ticks;
}

function renderChart(plan) {
  const box = $('#weightChart');
  const data = chartData(plan);
  const empty = !data.points.length;
  $('#chartEmpty').hidden = !empty;
  if (data.weightMode) {
    $('#chartEmpty').textContent = state.weights.length ? 'No weigh-ins in this time range.' : 'Log your weight with the + button on Today to see your progress here.';
  } else {
    $('#chartEmpty').textContent = state.weights.some((w) => w.bodyFat > 0)
      ? 'No body fat readings in this time range.'
      : 'No body fat readings yet. You can add one when you log your weight.';
  }
  box.hidden = empty;
  $('#chartLegend').hidden = empty;
  box.chart = null;
  if (empty) {
    box.innerHTML = '';
    return;
  }

  const W = Math.max(260, Math.round(box.clientWidth || box.parentElement.clientWidth - 32));
  const H = 220;
  const pad = { l: 38, r: 12, t: 12, b: 28 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const spanDays = Math.max(1, daysBetween(data.start, data.end));
  const x = (date) => pad.l + (daysBetween(data.start, date) / spanDays) * plotW;

  // The y range covers the dots, the line and the visible stretch of the plan.
  const values = [...data.points, ...data.line].map((p) => p.value);
  if (data.planLine) {
    const [a, b] = data.planLine;
    const at = (date) => a.value + (b.value - a.value) * (daysBetween(a.date, date) / Math.max(1, daysBetween(a.date, b.date)));
    const from = a.date > data.start ? a.date : data.start;
    const to = b.date < data.end ? b.date : data.end;
    if (from <= to) values.push(at(from), at(to));
  }
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const minSpan = data.weightMode ? (imperial() ? 4 : 2) : 2;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const ticks = niceTicks(lo, hi);
  const yLo = ticks[0];
  const yHi = ticks[ticks.length - 1];
  const y = (v) => pad.t + (1 - (v - yLo) / (yHi - yLo)) * plotH;
  const r1 = (v) => Math.round(v * 10) / 10;

  const svg = [];
  for (const t of ticks) {
    svg.push(`<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${r1(y(t))}" y2="${r1(y(t))}"/>`);
    svg.push(`<text class="tick" x="${pad.l - 6}" y="${r1(y(t)) + 4}" text-anchor="end">${t % 1 ? t.toFixed(1) : t}</text>`);
  }
  const xLabels = [[data.start, 'start'], [addDays(data.start, Math.round(spanDays / 2)), 'middle'], [data.end, 'end']];
  for (const [d, anchor] of xLabels) svg.push(`<text class="tick" x="${r1(x(d))}" y="${H - 8}" text-anchor="${anchor}">${esc(shortDate(d))}</text>`);
  if (data.end > data.today) {
    const tx = r1(x(data.today));
    svg.push(`<line class="today" x1="${tx}" x2="${tx}" y1="${pad.t}" y2="${pad.t + plotH}"/><text class="tick" x="${tx + 4}" y="${pad.t + 10}">Today</text>`);
  }
  if (data.planLine) {
    const [a, b] = data.planLine;
    svg.push(`<line class="plan" clip-path="url(#plotClip)" x1="${r1(x(a.date))}" y1="${r1(y(a.value))}" x2="${r1(x(b.date))}" y2="${r1(y(b.value))}"/>`);
    if (b.date >= data.start && b.date <= data.end) svg.push(`<circle class="goal-dot" cx="${r1(x(b.date))}" cy="${r1(y(b.value))}" r="4"/>`);
  }
  if (data.line.length > 1) {
    svg.push(`<path class="trend" d="${data.line.map((p, i) => `${i ? 'L' : 'M'}${r1(x(p.date))} ${r1(y(p.value))}`).join('')}"/>`);
  }
  for (const p of data.points) {
    svg.push(`<circle class="point" cx="${r1(x(p.date))}" cy="${r1(y(p.value))}" r="4"/>`);
  }
  svg.push(`<g class="cross" style="display:none"><line y1="${pad.t}" y2="${pad.t + plotH}"/><circle r="5"/></g>`);

  const label = `${data.weightMode ? 'Weight' : 'Body fat'} from ${shortDate(data.start)} to ${shortDate(data.end)}, ${data.points.length} reading${data.points.length === 1 ? '' : 's'}. Use the left and right arrow keys to read them.`;
  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" tabindex="0" role="img" aria-label="${esc(label)}">
      <defs><clipPath id="plotClip"><rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}"/></clipPath></defs>
      ${svg.join('')}
    </svg>
    <div class="chart-tip" hidden></div>`;
  const trendOn = new Map(data.line.map((p) => [p.date, p.value]));
  box.chart = {
    width: W,
    unit: data.unit,
    points: data.points.map((p) => ({ ...p, px: x(p.date), py: y(p.value), trend: trendOn.get(p.date) })),
    index: data.points.length - 1,
  };
  $('#chartLegend').innerHTML = `
    <span><i class="key dot"></i>${data.weightMode ? 'Weigh-in' : 'Reading'}</span>
    <span><i class="key line"></i>7-day average</span>
    ${data.planLine ? '<span><i class="key plan"></i>Plan</span>' : ''}`;
}

// Crosshair + tooltip on the nearest reading (pointer or arrow keys).
function showChartPoint(i) {
  const box = $('#weightChart');
  const c = box.chart;
  if (!c || !c.points.length) return;
  c.index = Math.max(0, Math.min(c.points.length - 1, i));
  const p = c.points[c.index];
  const cross = box.querySelector('.cross');
  cross.style.display = '';
  const line = cross.querySelector('line');
  line.setAttribute('x1', p.px);
  line.setAttribute('x2', p.px);
  cross.querySelector('circle').setAttribute('cx', p.px);
  cross.querySelector('circle').setAttribute('cy', p.py);
  const tip = box.querySelector('.chart-tip');
  tip.replaceChildren();
  const value = document.createElement('b');
  value.textContent = c.unit === '%' ? `${fmt(p.value)}%` : `${fmt(p.value)} ${c.unit}`;
  const detail = document.createElement('span');
  detail.textContent = `${shortDate(p.date)}${p.trend != null ? ` · avg ${fmt(p.trend)}` : ''}`;
  tip.append(value, detail);
  tip.hidden = false;
  const scale = box.clientWidth / c.width || 1;
  const left = Math.min(Math.max(p.px * scale - tip.offsetWidth / 2, 0), box.clientWidth - tip.offsetWidth);
  tip.style.left = `${left}px`;
}

function hideChartPoint() {
  const box = $('#weightChart');
  const cross = box.querySelector('.cross');
  if (cross) cross.style.display = 'none';
  const tip = box.querySelector('.chart-tip');
  if (tip) tip.hidden = true;
}

// ----- weight or body fat goal -----
const METRIC_NAMES = { weight: 'weight', bodyFat: 'body fat' };
// Which kind of goal the form shows: what you picked, else your goal's kind, else weight.
const goalFormMetric = (plan) => state.goalMetric || plan.goal?.metric || 'weight';

function renderGoalForm(plan) {
  const form = $('#weightGoalForm');
  const metric = goalFormMetric(plan);
  const g = plan.goal?.metric === metric ? plan.goal : null; // the goal the form edits
  const focus = document.activeElement;
  for (const b of document.querySelectorAll('#goalMetric button')) {
    const on = b.dataset.metric === metric;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('#goalTargetLabel').textContent = metric === 'weight' ? `Goal weight (${weightUnit()})` : 'Goal body fat (%)';
  if (form.target !== focus) form.target.value = g ? (metric === 'weight' ? toWeightUnit(g.target).toFixed(1) : fmt(g.target)) : '';
  if (form.date !== focus) form.date.value = g ? g.targetDate : '';
  form.date.min = addDays(plan.today, 1);
  $('#saveGoalBtn').textContent = g ? 'Update goal' : 'Set goal';
  $('#goalLinks').hidden = !g;
  $('#usePlanBtn').hidden = !(g && plan.target && !settings.get().goals?.auto);
  $('#goalSummary').innerHTML = goalSummary(plan, metric);
}

function goalSummary(plan, metric) {
  const g = plan.goal?.metric === metric ? plan.goal : null;
  const weight = metric === 'weight';
  if (!(weight ? plan.trend : plan.bodyFat)) {
    return weight
      ? '<p class="muted">Log your weight first. Your plan starts from your 7-day average.</p>'
      : '<p class="muted">Log your body fat first: add it when you log your weight. Your plan starts from your 7-day average.</p>';
  }
  if (!g) {
    const replaces = plan.goal ? ` This replaces your ${METRIC_NAMES[plan.goal.metric]} goal.` : '';
    return `<p class="muted">Pick a goal ${weight ? 'weight' : 'body fat'} and a date to get a daily and weekly guide.${replaces}</p>`;
  }
  const p = plan.progress;
  const verb = p.losing ? 'lose' : 'gain';
  const rate = weight ? rateText : bodyFatRateText;
  const between = `between ${esc(shortDate(g.startDate))} and ${esc(shortDate(g.targetDate))}`;
  const out = [weight
    ? `<p><b>Plan:</b> ${verb} ${esc(weightText(Math.abs(g.target - g.start)))} ${between}, about ${esc(rate(p.planPerDay))}.</p>`
    : `<p><b>Plan:</b> body fat from ${fmt(g.start)}% to ${fmt(g.target)}% ${between}, about ${esc(rate(p.planPerDay))}.</p>`];
  if (p.status === 'reached') {
    out.push('<p><b>You reached your goal.</b> Set a new one, or remove it to eat at maintenance.</p>');
  } else if (p.status === 'overdue') {
    out.push(`<p><b>The date has passed</b> with ${esc(goalValueText(metric, Math.abs(p.remaining)))} to go. Pick a new date to keep going.</p>`);
  } else {
    out.push(`<p><b>From today:</b> ${verb} ${esc(rate(p.neededPerDay))} to finish on time (${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left).</p>`);
    if (!weight) {
      out.push(`<p>At ${fmt(g.target)}% body fat you'd weigh about ${esc(weightText(p.goalKg))} if your lean mass (${esc(weightText(p.leanKg))}) stays the same, so your calories aim for that weight.</p>`);
    }
  }
  return out.join('');
}

// ----- about you -----
function buildActivityOptions() {
  $('#profileForm').activity.innerHTML = '<option value="">Choose…</option>'
    + ACTIVITY.map((a) => `<option value="${a.key}">${esc(a.label)}</option>`).join('');
}

function renderActivityHint() {
  const a = ACTIVITY.find((x) => x.key === $('#profileForm').activity.value);
  $('#activityHint').textContent = a ? a.hint[0].toUpperCase() + a.hint.slice(1) : '';
}

function renderProfile(plan) {
  const p = getProfile();
  const form = $('#profileForm');
  const focus = document.activeElement;
  const set = (el, v) => { if (el !== focus) el.value = v ?? ''; };
  const imp = imperial();
  const fi = p.heightCm ? feetInchesFromCm(p.heightCm) : null;
  set(form.sex, ['male', 'female'].includes(p.sex) ? p.sex : ''); // "Other" was a choice once: now unset
  set(form.age, p.age || '');
  set(form.activity, p.activity || '');
  set(form.units, imp ? 'imperial' : 'metric');
  set(form.feet, fi ? fi.ft : '');
  set(form.inches, fi ? fi.inches : '');
  set(form.cm, p.heightCm ? Math.round(p.heightCm) : '');
  $('#heightImperial').hidden = !imp;
  $('#heightMetric').hidden = imp;
  renderActivityHint();
  $('#maintenanceNote').textContent = maintenanceText(plan);
}

function maintenanceText(plan) {
  const m = plan.maint;
  if (m) {
    return `You burn about ${kcal(Math.round(m.calories / 10) * 10)} kcal a day: ${kcal(m.resting)} at rest × ${m.activity.factor} for being ${m.activity.label.toLowerCase()}${m.method === 'katch' ? ' (using your body fat %)' : ''}.`;
  }
  const p = plan.profile;
  const bodyFatKnown = Boolean(plan.trend?.bodyFat); // with body fat, sex, age and height aren't needed
  const missing = [];
  if (!plan.trend) missing.push('weight');
  if (!['male', 'female'].includes(p.sex) && !bodyFatKnown) missing.push('sex');
  if (!(p.age > 0) && !bodyFatKnown) missing.push('age');
  if (!(p.heightCm > 0) && !bodyFatKnown) missing.push('height');
  if (!p.activity) missing.push('activity level');
  return `Add your ${listText(missing)} to estimate the calories you burn in a day.`;
}

// Saves the "About you" form. Height is read in the units the form was showing.
function saveProfileForm() {
  const form = $('#profileForm');
  const heightCm = imperial()
    ? (form.feet.value || form.inches.value ? cmFromFeetInches(form.feet.value, form.inches.value) : undefined)
    : Number(form.cm.value) || undefined;
  saveProfile({
    sex: form.sex.value || undefined,
    age: Number(form.age.value) || undefined,
    heightCm,
    activity: form.activity.value || undefined,
    units: form.units.value,
  });
}

// ----- daily nutrition -----
function planText(plan) {
  if (!plan.trend) return 'Log your weight to use your plan. Until then, the calories below are used.';
  if (!plan.maint) return 'Fill in About you to use your plan. Until then, the calories below are used.';
  const maint = Math.round(plan.maint.calories / 10) * 10;
  const t = plan.target;
  const change = t.calories - maint; // both rounded to 10, so the sum below adds up
  if (!plan.goalActive || !change) {
    return `You burn about ${kcal(maint)} kcal a day, so that's your target${plan.goal ? '' : '. Set a goal above to lose or gain'}.`;
  }
  let text = `About ${kcal(maint)} kcal burned ${change < 0 ? '−' : '+'} ${kcal(Math.abs(change))} to ${change < 0 ? 'lose' : 'gain'} ${Math.abs(toWeightUnit(t.perWeekKg)).toFixed(1)} ${weightUnit()} a week = ${kcal(t.calories)} kcal a day.`;
  if (t.floored) text += ` That's the ${kcal(t.minimum)} kcal minimum; a later goal date would be gentler.`;
  return text;
}

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
  const plan = currentPlan();
  const custom = g.mode === 'custom';
  const following = g.fromPlan && Boolean(plan.target); // calories currently come from the plan
  $('#calorieSource').hidden = custom;
  for (const b of document.querySelectorAll('#calorieSource button')) {
    const on = (b.dataset.source === 'plan') === g.fromPlan;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('#planNote').hidden = !g.fromPlan;
  $('#planNote').textContent = g.fromPlan ? planText(plan) : '';
  for (const b of document.querySelectorAll('#goalModes button')) {
    const on = b.dataset.mode === g.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const cal = $('#goalCalories');
  cal.readOnly = custom || following;
  if (cal !== typing) cal.value = g.calories || '';
  for (const m of MACROS) {
    const input = $(`#goal-${m}`);
    input.readOnly = !custom;
    if (input !== typing) input.value = g[m] ? fmt(g[m]) : '';
  }
  const split = macroSplit(g);
  $('#goalHint').textContent = custom
    ? `Calories are worked out from your grams: protein and carbs are 4 kcal per gram, fat is 9.${split ? ` That's ${split.protein}% protein, ${split.carbs}% carbs and ${split.fat}% fat.` : ''}`
    : following ? 'The grams are worked out from your plan\'s calories.' : 'Enter your daily calories and the grams are worked out for you.';
  renderExtraGoals(); // the suggested sodium, sugar and fiber follow your calories
}

// ---------- sheets ----------
// While a sheet is open the page behind it is locked, so only the sheet scrolls (see .sheet-open in style.css).
// The sheet focuses itself (not its first button), so the close button doesn't show a focus ring.
function openSheet(dialog) {
  dialog.showModal();
  document.documentElement.classList.add('sheet-open');
  dialog.focus({ preventScroll: true });
}

// Unlock once the last sheet has closed (one sheet often opens another, e.g. Add → portion).
function sheetClosed() {
  if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
}

// ---------- add sheet ----------
function openAddSheet() {
  $('#addSearch').value = '';
  renderAddList();
  openSheet($('#addDialog'));
}

async function renderAddList() {
  await loadFoodsByUse();
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
    calories: '', protein: '', carbs: '', fat: '', sodium: '', sugar: '', fiber: '', defaultAmount: 1, defaultUnit: SERVING,
  };
  form.name.value = f.name;
  setEmoji(f.emoji);
  toggleEmojiGrid(false);
  form.servingAmount.value = f.servingAmount;
  fillUnitSelect(form.servingUnit, Object.keys(UNITS), f.servingUnit);
  form.servingAmount2.value = f.servingAmount2 || '';
  syncSecondUnits(f.servingUnit2 || '');
  for (const k of ['calories', 'protein', 'carbs', 'fat']) form[k].value = f[k] === '' ? '' : fmt(f[k]);
  // Foods saved before these existed have none: leave the fields blank rather than showing 0.
  for (const k of ['sodium', 'sugar', 'fiber']) form[k].value = f[k] === '' || f[k] == null ? '' : fmt(f[k]);
  form.defaultAmount.value = f.defaultAmount;
  syncDefaultUnits(f.defaultUnit);

  $('#foodDialogTitle').textContent = { new: 'New food', edit: 'Edit food', log: 'Custom food' }[mode];
  $('#foodSubmitBtn').textContent = mode === 'log' ? 'Next →' : 'Save';
  $('#deleteFoodBtn').hidden = mode !== 'edit';
  $('#saveFavRow').hidden = mode !== 'log';
  form.saveFav.checked = true;
  $('#scanStatus').hidden = true;
  openSheet($('#foodDialog'));
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
    sodium: num('sodium'),
    sugar: num('sugar'),
    fiber: num('fiber'),
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
    for (const k of ['calories', 'protein', 'carbs', 'fat', 'sodium', 'sugar', 'fiber']) {
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
  openSheet($('#portionDialog'));
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
  const extras = getExtras();
  const shown = EXTRAS.filter((x) => extras[x.key].show);
  $('#pvExtras').hidden = shown.length === 0;
  $('#pvExtras').textContent = shown.map((x) => `${x.label} ${extraText(x.key, n[x.key])}`).join(' · ');
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
        sodium: f.sodium,
        sugar: f.sugar,
        fiber: f.fiber,
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

// ---------- log weight ----------
// The weigh-in is for one day: the day being viewed on Today.
function openWeightDialog(date = state.date) {
  const form = $('#weightForm');
  form.reset();
  form.dataset.date = date > dateKey() ? dateKey() : date;
  form.unit.value = weightUnit();
  $('#weightDate').textContent = prettyDate(form.dataset.date);
  fillWeightForm();
  openSheet($('#weightDialog'));
}

// Shows that day's weigh-in (to edit), or a blank form with the previous one as a hint.
function fillWeightForm() {
  const form = $('#weightForm');
  const date = form.dataset.date;
  const existing = state.weights.find((w) => w.date === date);
  const before = [...state.weights].reverse().find((w) => w.date < date);
  const inUnit = (kg) => (form.unit.value === 'kg' ? kg : kgToLb(kg)).toFixed(1);
  form.weight.value = existing ? inUnit(existing.kg) : '';
  form.weight.placeholder = before ? inUnit(before.kg) : '';
  form.bodyFat.value = existing?.bodyFat ? fmt(existing.bodyFat) : '';
  $('#weightHint').textContent = before ? `Previous: ${inUnit(before.kg)} ${form.unit.value} on ${shortDate(before.date)}` : '';
  $('#deleteWeightBtn').hidden = !existing;
  $('#weightDialogTitle').textContent = existing ? 'Edit weight' : 'Log weight';
}

async function submitWeight() {
  const form = $('#weightForm');
  const { date } = form.dataset;
  const value = Number(form.weight.value);
  if (!(value > 0)) return toast('Enter your weight');
  const kg = form.unit.value === 'kg' ? value : lbToKg(value);
  if (kg < 20 || kg > 400) return toast("That weight doesn't look right");
  const bodyFat = form.bodyFat.value === '' ? null : Number(form.bodyFat.value);
  if (bodyFat !== null && !(bodyFat >= 3 && bodyFat <= 75)) return toast('Body fat should be between 3% and 75%');
  await db.putWeight({ date, kg, bodyFat });
  protectStorage();
  $('#weightDialog').close();
  toast(`Saved ${fmt(value)} ${form.unit.value}`);
  render();
}

// ---------- wiring ----------
function wire() {
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      if (b.dataset.view === 'today') state.historyOpen = false; // the Today tab always shows the day
      showView(b.dataset.view);
    });
  }
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
  // Tap the backdrop to close a sheet.
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.addEventListener('close', sheetClosed);
  }

  $('#prevDay').addEventListener('click', () => { state.date = shiftDate(state.date, -1); render(); });
  $('#nextDay').addEventListener('click', () => { state.date = shiftDate(state.date, 1); render(); });
  $('#dateLabel').addEventListener('click', () => {
    if (state.historyOpen) return;
    state.date = dateKey();
    render();
  });
  // Calendar button: history in place of the day; tapping again returns to the day you were on.
  $('#historyBtn').addEventListener('click', () => {
    state.historyOpen = !state.historyOpen;
    showView('today');
  });
  $('#fab').addEventListener('click', openAddSheet);
  $('#setGoalsHint').addEventListener('click', () => showView('goals'));

  $('#entryList').addEventListener('click', async (e) => {
    const weightLi = e.target.closest('li[data-weight]');
    if (weightLi) return openWeightDialog(weightLi.dataset.weight);
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const entry = (await db.entriesOn(state.date)).find((x) => x.id === li.dataset.id);
    if (entry) openPortion({ entry });
  });

  // Log weight
  const wf = $('#weightForm');
  wf.addEventListener('submit', (e) => { e.preventDefault(); submitWeight(); });
  wf.unit.addEventListener('change', () => {
    // Convert what's typed, and remember the choice for the whole app.
    const v = Number(wf.weight.value);
    if (v > 0) wf.weight.value = (wf.unit.value === 'kg' ? lbToKg(v) : kgToLb(v)).toFixed(1);
    saveProfile({ units: wf.unit.value === 'kg' ? 'metric' : 'imperial' });
    const typed = wf.weight.value;
    const typedBodyFat = wf.bodyFat.value;
    fillWeightForm();
    if (typed) wf.weight.value = typed;
    wf.bodyFat.value = typedBodyFat;
  });
  $('#deleteWeightBtn').addEventListener('click', async () => {
    await db.deleteWeight(wf.dataset.date);
    $('#weightDialog').close();
    toast('Weight removed');
    render();
  });
  $('#logWeightBtn').addEventListener('click', () => {
    $('#addDialog').close();
    openWeightDialog(state.date);
  });

  // Goals page: chart
  $('#chartRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    state.chartRange = b.dataset.range;
    renderProgress(currentPlan());
  });
  $('#chartMetric').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (!b) return;
    state.chartMetric = b.dataset.metric;
    renderProgress(currentPlan());
  });
  const chartBox = $('#weightChart');
  chartBox.addEventListener('pointermove', (e) => {
    const c = chartBox.chart;
    const svg = chartBox.querySelector('svg');
    if (!c || !svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * c.width;
    let best = 0;
    c.points.forEach((p, i) => { if (Math.abs(p.px - px) < Math.abs(c.points[best].px - px)) best = i; });
    showChartPoint(best);
  });
  chartBox.addEventListener('pointerleave', () => { if (!chartBox.contains(document.activeElement)) hideChartPoint(); });
  chartBox.addEventListener('focusin', () => showChartPoint(chartBox.chart?.index ?? 0));
  chartBox.addEventListener('focusout', hideChartPoint);
  chartBox.addEventListener('keydown', (e) => {
    const c = chartBox.chart;
    if (!c || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = { ArrowLeft: c.index - 1, ArrowRight: c.index + 1, Home: 0, End: c.points.length - 1 }[e.key];
    showChartPoint(i);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.view === 'goals') renderChart(currentPlan()); }, 150);
  });

  // Goals page: weight or body fat goal
  $('#goalMetric').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (!b) return;
    state.goalMetric = b.dataset.metric;
    renderGoalForm(currentPlan());
  });
  $('#weightGoalForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const plan = currentPlan();
    const metric = goalFormMetric(plan);
    const weight = metric === 'weight';
    const current = weight ? plan.trend?.kg : plan.bodyFat?.pct;
    if (!current) return toast(weight ? 'Log your weight first' : 'Log your body fat first');
    const value = Number(form.target.value);
    const targetDate = form.date.value;
    if (!(value > 0) || !targetDate) return toast(`Enter a goal ${weight ? 'weight' : 'body fat'} and a date`);
    if (!weight && !(value >= 3 && value <= 75)) return toast('Body fat should be between 3% and 75%');
    if (targetDate <= plan.today) return toast('Pick a date after today');
    const old = plan.goal?.metric === metric ? plan.goal : null;
    // Editing keeps the original start, so progress still counts from the beginning. A new goal starts
    // today, from your 7-day average (and replaces a goal of the other kind).
    const start = old ? { start: old.start, startDate: old.startDate } : { start: current, startDate: plan.today };
    settings.set({ weightGoal: goalRecord({ metric, ...start, target: weight ? fromWeightUnit(value) : value, targetDate }) });
    state.goalMetric = null;
    state.chartMetric = metric; // show the chart the goal is on
    toast(old ? 'Goal updated' : 'Goal set');
    form.target.blur();
    renderGoalsPage();
  });
  $('#usePlanBtn').addEventListener('click', () => {
    const g = normalizeGoals(settings.get());
    saveGoals({ ...(g.mode === 'custom' ? goalsFromCalories(g.calories, 'balanced') : g), auto: true });
    toast('Your daily calories now follow your plan');
    renderGoalsPage();
  });
  $('#restartGoalBtn').addEventListener('click', () => {
    const plan = currentPlan();
    const g = plan.goal;
    const current = g && (g.metric === 'weight' ? plan.trend?.kg : plan.bodyFat?.pct);
    if (!current) return;
    settings.set({ weightGoal: goalRecord({ ...g, start: current, startDate: plan.today }) });
    toast('Plan restarted from today');
    renderGoalsPage();
  });
  $('#removeGoalBtn').addEventListener('click', () => {
    const g = currentPlan().goal;
    if (!g || !confirm(`Remove your ${METRIC_NAMES[g.metric]} goal? Your weigh-ins stay.`)) return;
    settings.set({ weightGoal: undefined });
    state.goalMetric = null;
    renderGoalsPage();
  });

  // Goals page: about you
  const profileForm = $('#profileForm');
  profileForm.addEventListener('input', (e) => {
    if (e.target === profileForm.units) return;
    saveProfileForm();
    renderActivityHint();
    const plan = currentPlan();
    $('#maintenanceNote').textContent = maintenanceText(plan);
    renderGoalForm(plan);
    renderGoals();
  });
  profileForm.units.addEventListener('change', () => {
    saveProfileForm();
    renderGoalsPage();
  });

  // Settings: which extras show on Today
  for (const input of document.querySelectorAll('[data-extra-toggle]')) {
    input.addEventListener('change', () => saveExtra(input.dataset.extraToggle, { show: input.checked }));
  }
  // Goals page: sodium / sugar / fiber goals
  for (const x of EXTRAS) {
    $(`#goal-${x.key}`).addEventListener('input', (e) => {
      const v = e.target.value;
      if (v !== '' && !(Number(v) >= 0)) return;
      saveExtra(x.key, { target: v === '' ? null : Number(v) }); // blank = use the suggested amount
    });
  }

  // Goals page: where calories come from
  $('#calorieSource').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-source]');
    if (!b) return;
    saveGoals({ ...normalizeGoals(settings.get()), auto: b.dataset.source === 'plan' });
    renderGoals();
    renderGoalForm(currentPlan());
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

  // History → open that day
  $('#historyList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-date]');
    if (!li) return;
    state.date = li.dataset.date;
    state.historyOpen = false;
    showView('today');
  });

  // Settings: appearance
  $('#themeOptions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme-option]');
    if (b) setTheme(b.dataset.themeOption);
  });
  $('#accentSwatches').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-accent]');
    if (b) setAccent(b.dataset.accent);
  });
  // The custom color updates live while you move around the picker.
  $('#accentCustom').addEventListener('input', (e) => setAccent('custom', e.target.value));

  // Goals page: daily nutrition presets
  $('#goalModes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    const g = getGoals();
    const custom = b.dataset.mode === 'custom';
    // Switching keeps what you had: grams carry over into Custom, calories carry over into a preset.
    // Custom grams can't follow the plan; a preset keeps following it if it was.
    saveGoals({ ...(custom ? customGoals(g) : goalsFromCalories(g.calories, b.dataset.mode)), auto: !custom && g.fromPlan });
    renderGoals();
  });
  $('#goalCalories').addEventListener('input', (e) => {
    const g = getGoals();
    if (e.target.readOnly || g.mode === 'custom') return;
    saveGoals({ ...goalsFromCalories(e.target.value, g.mode), auto: false });
    renderGoals(e.target);
  });
  for (const m of MACROS) {
    $(`#goal-${m}`).addEventListener('input', (e) => {
      const g = getGoals();
      if (g.mode !== 'custom') return;
      saveGoals({ ...customGoals({ ...g, [m]: e.target.value }), auto: false });
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
buildActivityOptions();
buildAccentSwatches();
buildEmojiGrid();
wire();
showView('today');
startCloud();
// If sign-in couldn't load (e.g. first launch while offline), try again once back online.
window.addEventListener('online', startCloud);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

import { db, uid, settings } from './db.js';
import { firebaseConfig } from './firebase-config.js';
import {
  UNITS, KIND_LABELS, SERVING, compatibleUnits, convertible, servingMeasures, unitLabel, formatAmount,
  nutritionFor, sumNutrition, dateKey, shiftDate,
} from './units.js';
import { PRESETS, MACROS, goalsFromCalories, customGoals, macroSplit, normalizeGoals } from './goals.js';
import {
  ACTIVITY, kgToLb, lbToKg, cmFromFeetInches, feetInchesFromCm, daysBetween, addDays,
  trendAt, maintenance, goalProgress, calorieTarget,
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
  chartMetric: 'weight', // or 'bodyFat'
  showAllWeighIns: false,
};

// ---------- settings ----------
// Also drops the first version's goal/proteinGoal keys (JSON.stringify skips undefined).
const saveGoals = (goals) => settings.set({ goals, goal: undefined, proteinGoal: undefined });
const getProfile = () => settings.get().profile || {};
const saveProfile = (patch) => settings.set({ profile: { ...getProfile(), ...patch } });

// ---------- body weight & height units ----------
// Pounds and feet by default in the US (and Liberia and Myanmar), metric elsewhere.
const defaultUnits = () => (/-(US|LR|MM)$/i.test(navigator.language || '') ? 'imperial' : 'metric');
const imperial = () => (getProfile().units || defaultUnits()) === 'imperial';
const weightUnit = () => (imperial() ? 'lb' : 'kg');
const toWeightUnit = (kg) => (imperial() ? kgToLb(kg) : kg);
const fromWeightUnit = (v) => (imperial() ? lbToKg(v) : v);
const weightText = (kg) => `${toWeightUnit(kg).toFixed(1)} ${weightUnit()}`;
const weightChange = (kg) => `${kg < 0 ? '−' : '+'}${Math.abs(toWeightUnit(kg)).toFixed(1)} ${weightUnit()}`;
// "1.2 lb a week (0.17 lb a day)" from a rate in kg per day
const rateText = (kgPerDay) => {
  const u = weightUnit();
  return `${Math.abs(toWeightUnit(kgPerDay * 7)).toFixed(1)} ${u} a week (${Math.abs(toWeightUnit(kgPerDay)).toFixed(2)} ${u} a day)`;
};

async function loadWeights() {
  state.weights = await db.allWeights();
}

// Everything the goals depend on, worked out from today's numbers.
function currentPlan() {
  const s = settings.get();
  const today = dateKey();
  const profile = s.profile || {};
  const trend = trendAt(state.weights, today);
  const maint = trend ? maintenance(profile, trend.kg, trend.bodyFat) : null;
  const goal = s.weightGoal && trend ? goalProgress(s.weightGoal, trend.kg, today) : null;
  const goalActive = Boolean(goal) && !['reached', 'overdue'].includes(goal.status);
  // Aim for the pace that still finishes on time, so being behind or ahead adjusts the calories.
  const target = maint ? calorieTarget(maint.calories, goalActive ? goal.neededPerDay * 7 : 0, trend.kg, profile.sex) : null;
  return { today, profile, trend, maint, weightGoal: s.weightGoal || null, goal, goalActive, target };
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
  renderWeightGoal(plan);
  renderGoals();
  renderProfile(plan);
  renderWeighIns();
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
  const range = state.chartRange || (plan.weightGoal ? 'goal' : '90');
  return range === 'goal' && !plan.weightGoal ? '90' : range;
}

function renderProgress(plan) {
  const weightMode = state.chartMetric === 'weight';
  const range = chartRange(plan);
  for (const b of document.querySelectorAll('#chartRange button')) {
    b.hidden = b.dataset.range === 'goal' && !plan.weightGoal;
    b.classList.toggle('active', b.dataset.range === range);
    b.setAttribute('aria-pressed', String(b.dataset.range === range));
  }
  for (const b of document.querySelectorAll('#chartMetric button')) {
    const on = b.dataset.metric === state.chartMetric;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const status = $('#progressStatus');
  status.hidden = true;
  if (weightMode) {
    const g = plan.weightGoal;
    $('#progressLabel').textContent = 'Weight, 7-day average';
    $('#progressValue').textContent = plan.trend ? toWeightUnit(plan.trend.kg).toFixed(1) : '–';
    $('#progressUnit').textContent = plan.trend ? weightUnit() : '';
    $('#progressSub').textContent = plan.trend && g
      ? `${weightChange(plan.trend.kg - g.startKg)} since ${shortDate(g.startDate)} · goal ${weightText(g.targetKg)} by ${shortDate(g.targetDate)}`
      : plan.trend ? `Last weigh-in ${shortDate(plan.trend.lastDate)}` : '';
    if (plan.goal) {
      const s = STATUS[plan.goal.status];
      const by = ['behind', 'ahead'].includes(plan.goal.status) ? ` by ${Math.abs(toWeightUnit(plan.goal.diffKg)).toFixed(1)} ${weightUnit()}` : '';
      status.textContent = `${s.mark} ${s.text}${by}`;
      status.dataset.tone = s.tone;
      status.hidden = false;
    }
  } else {
    const latest = [...state.weights].reverse().find((w) => w.bodyFat > 0);
    $('#progressLabel').textContent = 'Body fat';
    $('#progressValue').textContent = latest ? fmt(latest.bodyFat) : '–';
    $('#progressUnit').textContent = latest ? '%' : '';
    $('#progressSub').textContent = latest ? `Measured ${shortDate(latest.date)}` : '';
  }
  renderChart(plan);
}

// ----- weight chart (inline SVG) -----
// What to plot for the chosen measure and time range, in display units.
function chartData(plan) {
  const weightMode = state.chartMetric === 'weight';
  const today = dateKey();
  const series = weightMode
    ? state.weights.map((w) => ({ date: w.date, value: toWeightUnit(w.kg) }))
    : state.weights.filter((w) => w.bodyFat > 0).map((w) => ({ date: w.date, value: w.bodyFat }));
  const goal = plan.weightGoal;
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
  // Weight: dots are the weigh-ins, the line their 7-day average. Body fat: one line through the readings.
  const line = weightMode
    ? points.map((p) => ({ date: p.date, value: toWeightUnit(trendAt(state.weights, p.date).kg) }))
    : points;
  const planLine = weightMode && goal
    ? [{ date: goal.startDate, value: toWeightUnit(goal.startKg) }, { date: goal.targetDate, value: toWeightUnit(goal.targetKg) }]
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
  $('#chartEmpty').textContent = !data.weightMode
    ? 'No body fat readings yet. You can add one when you log your weight.'
    : state.weights.length ? 'No weigh-ins in this time range.' : 'Log your weight with the + button on Today to see your progress here.';
  box.hidden = empty;
  $('#chartLegend').hidden = empty || !data.weightMode;
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
    svg.push(`<circle class="point${data.weightMode ? '' : ' main'}" cx="${r1(x(p.date))}" cy="${r1(y(p.value))}" r="4"/>`);
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
    weightMode: data.weightMode,
    unit: data.unit,
    points: data.points.map((p) => ({ ...p, px: x(p.date), py: y(p.value), trend: data.weightMode ? trendOn.get(p.date) : null })),
    index: data.points.length - 1,
  };
  $('#chartLegend').innerHTML = `
    <span><i class="key dot"></i>Weigh-in</span>
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
  value.textContent = `${fmt(p.value)} ${c.unit}`;
  const detail = document.createElement('span');
  detail.textContent = `${shortDate(p.date)}${c.weightMode && p.trend != null ? ` · avg ${fmt(p.trend)}` : ''}`;
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

function renderWeighIns() {
  const all = [...state.weights].reverse();
  const shown = state.showAllWeighIns ? all : all.slice(0, 5);
  $('#weighInEmpty').hidden = all.length > 0;
  $('#showAllWeighIns').hidden = all.length <= 5 || state.showAllWeighIns;
  $('#weighInList').innerHTML = shown
    .map((w) => `
      <li data-weight="${w.date}">
        <div class="grow">
          <div class="name">${esc(shortDate(w.date))}</div>
          ${w.bodyFat ? `<div class="muted small">${fmt(w.bodyFat)}% body fat</div>` : ''}
        </div>
        <div class="kcal">${toWeightUnit(w.kg).toFixed(1)}<small>${weightUnit()}</small></div>
      </li>`)
    .join('');
}

// ----- weight goal -----
function renderWeightGoal(plan) {
  const form = $('#weightGoalForm');
  const g = plan.weightGoal;
  const focus = document.activeElement;
  for (const el of document.querySelectorAll('.wunit')) el.textContent = weightUnit();
  if (form.target !== focus) form.target.value = g ? toWeightUnit(g.targetKg).toFixed(1) : '';
  if (form.date !== focus) form.date.value = g ? g.targetDate : '';
  form.date.min = addDays(plan.today, 1);
  $('#saveGoalBtn').textContent = g ? 'Update goal' : 'Set goal';
  $('#goalLinks').hidden = !g;
  $('#usePlanBtn').hidden = !(g && plan.target && !settings.get().goals?.auto);
  $('#goalSummary').innerHTML = goalSummary(plan);
}

function goalSummary(plan) {
  const g = plan.weightGoal;
  if (!plan.trend) return '<p class="muted">Log your weight first. Your plan starts from your current weight.</p>';
  if (!g) return '<p class="muted">Pick a goal weight and a date to get a daily and weekly guide.</p>';
  const p = plan.goal;
  const verb = p.losing ? 'Lose' : 'Gain';
  const out = [
    `<p><b>Plan:</b> ${verb.toLowerCase()} ${esc(weightText(Math.abs(g.targetKg - g.startKg)))} between ${esc(shortDate(g.startDate))} and ${esc(shortDate(g.targetDate))}, about ${esc(rateText(p.planPerDay))}.</p>`,
  ];
  if (p.status === 'reached') {
    out.push('<p><b>You reached your goal.</b> Set a new one, or remove it to eat at maintenance.</p>');
  } else if (p.status === 'overdue') {
    out.push(`<p><b>The date has passed</b> with ${esc(weightText(Math.abs(p.remainingKg)))} to go. Pick a new date to keep going.</p>`);
  } else {
    out.push(`<p><b>From today:</b> ${verb.toLowerCase()} ${esc(rateText(p.neededPerDay))} to finish on time (${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left).</p>`);
    const weekly = Math.abs(p.neededPerDay * 7);
    if (weekly > plan.trend.kg * (p.losing ? 0.01 : 0.005)) {
      out.push(`<p class="warn-text">That's faster than ${p.losing ? '1%' : '0.5%'} of your body weight a week, which is hard to sustain, so your calories are capped at a safer pace. A later date would be more realistic.</p>`);
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
  set(form.sex, p.sex || '');
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
  const bodyFatKnown = Boolean(plan.trend?.bodyFat);
  const missing = [];
  if (!plan.trend) missing.push('weight');
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
  if (!plan.goalActive) {
    return `You burn about ${kcal(maint)} kcal a day, so that's your target${plan.weightGoal ? '' : '. Set a weight goal above to lose or gain'}.`;
  }
  const t = plan.target;
  const verb = plan.goal.losing ? 'lose' : 'gain';
  let text = `About ${kcal(maint)} kcal burned ${t.adjustment < 0 ? '−' : '+'} ${kcal(Math.abs(t.adjustment))} to ${verb} ${Math.abs(toWeightUnit(t.perWeekKg)).toFixed(1)} ${weightUnit()} a week = ${kcal(t.calories)} kcal a day.`;
  if (t.floored) text += ` That's the ${kcal(t.minimum)} kcal minimum; a later goal date would be gentler.`;
  else if (t.limited) text += ' Capped at a safe pace.';
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
}

// ---------- sheets ----------
// Focus the sheet itself on open (not its first button), so the close button doesn't show a focus ring.
function openSheet(dialog) {
  dialog.showModal();
  dialog.focus({ preventScroll: true });
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

// ---------- log weight ----------
// The weigh-in is for one day: the day being viewed on Today (today when opened from Goals).
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

  // Goals page: weigh-ins
  $('#weighInList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-weight]');
    if (li) openWeightDialog(li.dataset.weight);
  });
  $('#goalsLogWeightBtn').addEventListener('click', () => openWeightDialog(dateKey()));
  $('#showAllWeighIns').addEventListener('click', () => {
    state.showAllWeighIns = true;
    renderWeighIns();
  });

  // Goals page: weight goal
  $('#weightGoalForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const plan = currentPlan();
    if (!plan.trend) return toast('Log your weight first');
    const targetKg = fromWeightUnit(Number(form.target.value));
    const targetDate = form.date.value;
    if (!(targetKg > 0) || !targetDate) return toast('Enter a goal weight and a date');
    if (targetDate <= plan.today) return toast('Pick a date after today');
    const old = plan.weightGoal;
    // Editing keeps the original start, so progress still counts from the beginning.
    const start = old ? { startKg: old.startKg, startDate: old.startDate } : { startKg: plan.trend.kg, startDate: plan.today };
    settings.set({ weightGoal: { ...start, targetKg, targetDate } });
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
    if (!plan.trend || !plan.weightGoal) return;
    settings.set({ weightGoal: { ...plan.weightGoal, startKg: plan.trend.kg, startDate: plan.today } });
    toast('Plan restarted from today');
    renderGoalsPage();
  });
  $('#removeGoalBtn').addEventListener('click', () => {
    if (!confirm('Remove your weight goal? Your weigh-ins stay.')) return;
    settings.set({ weightGoal: undefined });
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
    renderWeightGoal(plan);
    renderGoals();
  });
  profileForm.units.addEventListener('change', () => {
    saveProfileForm();
    renderGoalsPage();
  });

  // Goals page: where calories come from
  $('#calorieSource').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-source]');
    if (!b) return;
    saveGoals({ ...normalizeGoals(settings.get()), auto: b.dataset.source === 'plan' });
    renderGoals();
    renderWeightGoal(currentPlan());
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

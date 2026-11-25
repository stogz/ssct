// Weight and body fat goals, and calorie estimates. Pure functions, no DOM.
// Internally weights are kg and heights cm; the app converts for display.

export const KG_PER_LB = 0.45359237;
export const CM_PER_INCH = 2.54;
export const kgToLb = (kg) => kg / KG_PER_LB;
export const lbToKg = (lb) => lb * KG_PER_LB;
export const cmFromFeetInches = (ft, inches) => ((Number(ft) || 0) * 12 + (Number(inches) || 0)) * CM_PER_INCH;
export function feetInchesFromCm(cm) {
  const total = Math.round(cm / CM_PER_INCH);
  return { ft: Math.floor(total / 12), inches: total % 12 };
}

// Energy in a kilogram of body-weight change (the familiar ~3,500 kcal per pound).
export const KCAL_PER_KG = 7700;

export const ACTIVITY = [
  { key: 'sedentary', label: 'Sedentary', hint: 'desk job, little exercise', factor: 1.2 },
  { key: 'light', label: 'Lightly active', hint: 'exercise 1–3 days a week', factor: 1.375 },
  { key: 'moderate', label: 'Moderately active', hint: 'exercise 3–5 days a week', factor: 1.55 },
  { key: 'active', label: 'Very active', hint: 'hard exercise 6–7 days a week', factor: 1.725 },
  { key: 'extra', label: 'Extra active', hint: 'physical job plus hard exercise', factor: 1.9 },
];

// ----- dates (YYYY-MM-DD keys, counted in whole days) -----
const DAY = 86400000;
const utc = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY);
export const addDays = (key, n) => new Date(utc(key) + n * DAY).toISOString().slice(0, 10);

// Smoothed weight on `date`: the average of the weigh-ins in the 7 days up to it (or the latest one
// before that), so a salty dinner doesn't look like a setback. Body fat: smoothed the same way, but only
// from readings in the 30 days up to `date` (an old reading says little about today's body).
// `weights` ({ date, kg, bodyFat }) must be sorted oldest first.
export function trendAt(weights, date) {
  const upTo = weights.filter((w) => w.date <= date);
  if (!upTo.length) return null;
  const bf = bodyFatAt(weights, date);
  return {
    kg: weekAverage(upTo, date, (w) => w.kg),
    bodyFat: bf && bf.lastDate >= addDays(date, -29) ? bf.pct : null,
    lastDate: upTo[upTo.length - 1].date,
  };
}

// Smoothed body fat on `date`: the average of the readings in the 7 days up to it, or the latest reading
// before that however old. `lastDate` is when the latest reading was taken.
export function bodyFatAt(weights, date) {
  const upTo = weights.filter((w) => w.date <= date && w.bodyFat > 0);
  if (!upTo.length) return null;
  return { pct: weekAverage(upTo, date, (w) => w.bodyFat), lastDate: upTo[upTo.length - 1].date };
}

// Average of `value` over the rows in the 7 days up to `date`, or the last row if none are that recent.
function weekAverage(rows, date, value) {
  const weekStart = addDays(date, -6);
  const week = rows.filter((w) => w.date >= weekStart);
  const used = week.length ? week : [rows[rows.length - 1]];
  return used.reduce((sum, w) => sum + value(w), 0) / used.length;
}

// Resting energy per day: Katch-McArdle when body fat is known (it uses lean mass),
// otherwise Mifflin-St Jeor from sex, age, height and weight.
export function restingCalories(profile, weightKg, bodyFat) {
  if (!(weightKg > 0)) return null;
  if (bodyFat > 0 && bodyFat < 70) {
    return { kcal: 370 + 21.6 * weightKg * (1 - bodyFat / 100), method: 'katch' };
  }
  const { age, heightCm, sex } = profile || {};
  if (!(age > 0 && heightCm > 0) || !['male', 'female'].includes(sex)) return null;
  return { kcal: 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161), method: 'mifflin' };
}

// Calories a day that keep your weight steady.
export function maintenance(profile, weightKg, bodyFat) {
  const activity = ACTIVITY.find((a) => a.key === profile?.activity);
  const rest = restingCalories(profile, weightKg, bodyFat);
  if (!activity || !rest) return null;
  return { calories: rest.kcal * activity.factor, resting: rest.kcal, method: rest.method, activity };
}

// ----- weight and body fat goals -----
// A goal is { metric: 'weight' | 'bodyFat', start, target, startDate, targetDate }, with start and target
// in kg or body fat %. Saved, weight goals keep the startKg/targetKg names they always had, and body fat
// goals use startPct/targetPct.
export function normalizeGoal(saved) {
  if (!saved?.startDate || !saved?.targetDate) return null;
  const metric = saved.metric === 'bodyFat' ? 'bodyFat' : 'weight';
  const [start, target] = metric === 'bodyFat' ? [saved.startPct, saved.targetPct] : [saved.startKg, saved.targetKg];
  if (!(start > 0 && target > 0)) return null;
  return { metric, start, target, startDate: saved.startDate, targetDate: saved.targetDate };
}

export function goalRecord({ metric, start, target, startDate, targetDate }) {
  return metric === 'bodyFat'
    ? { metric, startDate, targetDate, startPct: start, targetPct: target }
    : { metric: 'weight', startDate, targetDate, startKg: start, targetKg: target };
}

// A goal starts from your 7-day average on its start date, worked out from your weigh-ins the same way as
// your current average, so a new goal starts on track, and weigh-ins added later for earlier days (or
// synced from another device) move the start along with the average. The saved start is the fallback
// when no weigh-ins reach back that far.
export function goalStart(goal, weights) {
  const at = goal.metric === 'bodyFat' ? bodyFatAt(weights, goal.startDate)?.pct : trendAt(weights, goal.startDate)?.kg;
  return at > 0 ? at : goal.start;
}

// How far from the plan still counts as on track: normal day-to-day noise.
export const weightTolerance = (kg) => Math.max(0.25, kg * 0.003);
export const BODY_FAT_TOLERANCE = 0.5; // percentage points

// Where you stand against a goal on `today`, with `current` in the goal's unit (kg or %).
// Rates are per day; negative means going down.
export function goalProgress(goal, current, today, tolerance) {
  const totalDays = Math.max(1, daysBetween(goal.startDate, goal.targetDate));
  const losing = goal.target < goal.start;
  const planPerDay = (goal.target - goal.start) / totalDays;
  const elapsed = Math.min(Math.max(daysBetween(goal.startDate, today), 0), totalDays);
  const expected = goal.start + planPerDay * elapsed;
  const daysLeft = daysBetween(today, goal.targetDate);
  const remaining = goal.target - current;
  const reached = losing ? current <= goal.target : current >= goal.target;
  const neededPerDay = daysLeft > 0 ? remaining / daysLeft : 0;
  const diff = current - expected; // positive = above where the plan says you'd be today
  let status;
  if (reached) status = 'reached';
  else if (daysLeft <= 0) status = 'overdue';
  else if (Math.abs(diff) <= tolerance) status = 'on-track';
  else status = (losing ? diff > 0 : diff < 0) ? 'behind' : 'ahead';
  return { losing, totalDays, daysLeft, planPerDay, neededPerDay, expected, diff, remaining, status };
}

// What you'd weigh at `targetPct` body fat if your lean mass (everything but fat) stays the same.
export function weightAtBodyFat(weightKg, bodyFatPct, targetPct) {
  return (weightKg * (1 - bodyFatPct / 100)) / (1 - targetPct / 100);
}

// Daily calories for changing weight by `perWeekKg` (negative = lose), at whatever pace the goal needs,
// but never below a minimum (1,500 kcal for men, 1,200 otherwise) unless maintenance itself is lower.
export function calorieTarget(maintenanceKcal, perWeekKg, sex) {
  const minimum = Math.min(sex === 'male' ? 1500 : 1200, maintenanceKcal);
  const raw = maintenanceKcal + (perWeekKg * KCAL_PER_KG) / 7;
  const floored = raw < minimum;
  const calories = Math.round(Math.max(raw, minimum) / 10) * 10;
  return {
    calories,
    adjustment: calories - maintenanceKcal, // kcal a day below (negative) or above maintenance
    perWeekKg: ((calories - maintenanceKcal) * 7) / KCAL_PER_KG, // what these calories actually aim for
    floored,
    minimum,
  };
}

// Daily sodium, sugar and fiber amounts suggested for you.
//  - Fiber: at least 14 g per 1,000 kcal eaten (US National Academies; the basis of the 25–38 g adult targets).
//  - Sugar: under 10% of calories (WHO and US Dietary Guidelines advice on sugars), at 4 kcal per gram.
//  - Sodium: under 2,300 mg from age 14 (1,800 mg at 9–13), the limit for lowering long-term health risks.
//    It's set by age only: guidelines don't scale it with body size.
// `calories` is your daily calorie target (from your plan: height, weight, age, sex and activity). Without it,
// fiber falls back to the Adequate Intake for your age and sex, and sugar to 50 g (10% of 2,000 kcal).
export function suggestedExtras({ calories, age, sex } = {}) {
  const sodium = age > 0 && age < 14 ? 1800 : 2300;
  if (calories > 0) {
    return { sodium, sugar: Math.round((calories * 0.1) / 4), fiber: Math.round((calories * 14) / 1000) };
  }
  let fiber = 28;
  if (sex === 'male') fiber = age >= 51 ? 30 : 38;
  else if (sex === 'female') fiber = age >= 51 ? 21 : 25;
  return { sodium, sugar: 50, fiber };
}

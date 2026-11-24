// Weight goals and calorie estimates. Pure functions, no DOM.
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
// before that), so a salty dinner doesn't look like a setback. Body fat: the latest reading from the
// 30 days up to `date`. `weights` ({ date, kg, bodyFat }) must be sorted oldest first.
export function trendAt(weights, date) {
  const upTo = weights.filter((w) => w.date <= date);
  if (!upTo.length) return null;
  const weekStart = addDays(date, -6);
  const week = upTo.filter((w) => w.date >= weekStart);
  const used = week.length ? week : [upTo[upTo.length - 1]];
  const kg = used.reduce((sum, w) => sum + w.kg, 0) / used.length;
  const bodyFatStart = addDays(date, -29);
  const bf = [...upTo].reverse().find((w) => w.bodyFat > 0 && w.date >= bodyFatStart);
  return { kg, bodyFat: bf ? bf.bodyFat : null, lastDate: upTo[upTo.length - 1].date };
}

// Resting energy per day: Katch-McArdle when body fat is known (it uses lean mass),
// otherwise Mifflin-St Jeor from sex, age, height and weight.
export function restingCalories(profile, weightKg, bodyFat) {
  if (!(weightKg > 0)) return null;
  if (bodyFat > 0 && bodyFat < 70) {
    return { kcal: 370 + 21.6 * weightKg * (1 - bodyFat / 100), method: 'katch' };
  }
  const { age, heightCm, sex } = profile || {};
  if (!(age > 0 && heightCm > 0)) return null;
  const sexTerm = sex === 'male' ? 5 : sex === 'female' ? -161 : -78; // -78: halfway, for "other"
  return { kcal: 10 * weightKg + 6.25 * heightCm - 5 * age + sexTerm, method: 'mifflin' };
}

// Calories a day that keep your weight steady.
export function maintenance(profile, weightKg, bodyFat) {
  const activity = ACTIVITY.find((a) => a.key === profile?.activity);
  const rest = restingCalories(profile, weightKg, bodyFat);
  if (!activity || !rest) return null;
  return { calories: rest.kcal * activity.factor, resting: rest.kcal, method: rest.method, activity };
}

// Where you stand against a goal { startKg, startDate, targetKg, targetDate } on `today`.
// Rates are kg per day; negative means losing.
export function goalProgress(goal, currentKg, today) {
  const totalDays = Math.max(1, daysBetween(goal.startDate, goal.targetDate));
  const losing = goal.targetKg < goal.startKg;
  const planPerDay = (goal.targetKg - goal.startKg) / totalDays;
  const elapsed = Math.min(Math.max(daysBetween(goal.startDate, today), 0), totalDays);
  const expectedKg = goal.startKg + planPerDay * elapsed;
  const daysLeft = daysBetween(today, goal.targetDate);
  const remainingKg = goal.targetKg - currentKg;
  const reached = losing ? currentKg <= goal.targetKg : currentKg >= goal.targetKg;
  const neededPerDay = daysLeft > 0 ? remainingKg / daysLeft : 0;
  const diffKg = currentKg - expectedKg; // positive = heavier than the plan says for today
  const tolerance = Math.max(0.25, currentKg * 0.003); // normal day-to-day noise
  let status;
  if (reached) status = 'reached';
  else if (daysLeft <= 0) status = 'overdue';
  else if (Math.abs(diffKg) <= tolerance) status = 'on-track';
  else status = (losing ? diffKg > 0 : diffKg < 0) ? 'behind' : 'ahead';
  return { losing, totalDays, daysLeft, planPerDay, neededPerDay, expectedKg, diffKg, remainingKg, status };
}

// Daily calories for changing weight by `perWeekKg` (negative = lose), within safe limits:
// lose at most 1% of body weight a week, gain at most 0.5%, and never eat below a minimum
// (1,500 kcal for men, 1,200 for women, 1,350 otherwise) unless maintenance itself is lower.
export function calorieTarget(maintenanceKcal, perWeekKg, weightKg, sex) {
  const rate = Math.min(Math.max(perWeekKg, -weightKg * 0.01), weightKg * 0.005);
  const minimum = Math.min(sex === 'male' ? 1500 : sex === 'female' ? 1200 : 1350, maintenanceKcal);
  const raw = maintenanceKcal + (rate * KCAL_PER_KG) / 7;
  const floored = raw < minimum;
  const calories = Math.round(Math.max(raw, minimum) / 10) * 10;
  return {
    calories,
    adjustment: calories - maintenanceKcal, // kcal a day below (negative) or above maintenance
    perWeekKg: ((calories - maintenanceKcal) * 7) / KCAL_PER_KG, // what these calories actually aim for
    limited: Math.abs(rate - perWeekKg) > 1e-9,
    floored,
    minimum,
  };
}
